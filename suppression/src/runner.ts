import type { LocalAccount } from "viem/accounts";
import { decideNext, exclusionIsComplete, executionModeFor } from "./core.ts";
import { conversionEventId, idempotencyKey } from "./idempotency.ts";
import { buildReceiptBody, signReceipt } from "./receipt.ts";
import {
  envelopeFingerprint,
  redactOutcome,
  subjectCommitment,
  type RedactableOutcome,
} from "./redaction.ts";
import type { SuppressionStore, TransitionRecord } from "./store.ts";
import type { AdapterOutcome, SuppressionAdapter } from "./adapters/types.ts";
import { UNIDENTIFIED_SUBJECT } from "./types.ts";
import type {
  LifecycleState,
  SuppressionEnvelope,
  SuppressionPolicy,
  SuppressionReceipt,
  VerifiedClaim,
} from "./types.ts";

/**
 * Drives one claim from verification to a signed receipt.
 *
 * The loop is deliberately shaped as decide → act → record → decide again.
 * Every external effect is preceded by a durable transition, so a crash resumes
 * from what was written rather than from an in-memory plan, and the idempotency
 * key for a repeated action is derived rather than remembered.
 *
 * Nothing here touches settlement. A claim can fail every step below and still
 * be paid; a payment can fail and this still runs. That independence is the
 * point of the module, not an incidental property.
 */

export interface EnvelopeFetch {
  ok: boolean;
  envelope?: SuppressionEnvelope | undefined;
  reason?: string | undefined;
  /** Whether refetching could plausibly succeed. A 401 cannot; a timeout can. */
  retryable?: boolean | undefined;
}

export interface RunnerDeps {
  store: SuppressionStore;
  adapter: SuppressionAdapter;
  policy: SuppressionPolicy;
  signer: LocalAccount;
  tenantId: string;
  commitmentKey: string;
  fetchEnvelope: (claim: VerifiedClaim) => Promise<EnvelopeFetch>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Exponential with a ceiling. No jitter: a single-process worker gains nothing
 * from it, and determinism is worth more here than herd avoidance. */
export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);
}

/** A loop that cannot terminate is worse than one that gives up. Each iteration
 * either records a transition or returns, so this ceiling is unreachable in
 * normal operation and exists to turn a logic defect into a loud failure. */
const MAX_ITERATIONS = 64;

export async function processClaim(
  claim: VerifiedClaim,
  deps: RunnerDeps,
): Promise<SuppressionReceipt> {
  const { store, policy } = deps;
  const { campaignId, claimId } = claim;
  const platform = policy.platform;
  const stamp = () => new Date(deps.now()).toISOString();

  if (!store.known(campaignId, claimId, platform)) {
    store.append({
      type: "intent",
      at: stamp(),
      campaignId,
      claimId,
      evidenceHash: claim.evidenceHash,
      platform,
      verifiedAtBlock: claim.verifiedAtBlock,
    });
  }

  // Held in memory only. The envelope carries the buyer's platform identifiers,
  // so it is the one thing in this flow that must never reach the journal.
  let envelope: SuppressionEnvelope | null = null;

  // Seeded from the journal rather than started empty. A worker resuming after
  // a crash has already done some of this work, and a receipt built from a
  // blank slate would report an acceptance that happened as if it had not.
  const resumed = store.progress(campaignId, claimId, platform);
  const outcomes: unknown[] = resumed.outcomes;
  let audienceAcceptedAt: string | null = resumed.audienceAcceptedAt;
  let exclusionDigest: string | null = resumed.exclusionDigest;
  let provenCommitment: string | null = resumed.subjectCommitment;
  let provenFingerprint: string | null = resumed.envelopeFingerprint;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const state = store.state(campaignId, claimId, platform);
    const action = decideNext(claim, envelope, state, policy, deps.now());
    const attempt = state.attempts + 1;

    switch (action.kind) {
      case "done": {
        const receipt = store.receipt(campaignId, claimId, platform);
        if (!receipt) throw new Error("suppression: state says signed but no receipt was stored");
        return receipt;
      }

      case "skip":
        record(deps, claim, "SKIPPED", state.attempts, { skipReason: action.reason });
        break;

      case "abort":
        record(deps, claim, "FAILED_PERMANENT", state.attempts, {
          failure: { permanent: true, code: action.code },
        });
        break;

      case "fetch-envelope": {
        const fetched = await deps.fetchEnvelope(claim);
        if (fetched.ok && fetched.envelope) {
          const candidate = fetched.envelope;
          // Derived here, where the envelope is authenticated and in hand, and
          // written with the transition. Recomputing at signing time would need
          // the envelope again, and after a crash the merchant may be gone —
          // which is how a receipt ends up bound to a commitment for nobody.
          const commitment = subjectCommitment(
            deps.commitmentKey,
            deps.tenantId,
            candidate.subjectRef,
          );
          const fingerprint = envelopeFingerprint(deps.commitmentKey, deps.tenantId, candidate);

          // A merchant is authenticated, not infallible. On a resume it may
          // answer the same evidence hash with a different buyer, or the same
          // buyer with different identifiers — and the platform would receive
          // the new one while the receipt still named the old. Checked before
          // the envelope is adopted, so no adapter call can use it.
          const rebound =
            (provenCommitment !== null && provenCommitment !== commitment) ||
            (provenFingerprint !== null && provenFingerprint !== fingerprint);
          if (rebound) {
            record(deps, claim, "FAILED_PERMANENT", attempt, {
              failure: { permanent: true, code: "ENVELOPE_REBOUND" },
            });
            break;
          }

          envelope = candidate;
          provenCommitment = commitment;
          provenFingerprint = fingerprint;
          record(deps, claim, "ENVELOPE_FETCHED", attempt, {
            subjectCommitment: commitment,
            envelopeFingerprint: fingerprint,
          });
          break;
        }
        const permanent = fetched.retryable !== true;
        record(deps, claim, permanent ? "FAILED_PERMANENT" : "RETRY_SCHEDULED", attempt, {
          failure: { permanent, code: fetched.reason ?? "ENVELOPE_UNAVAILABLE" },
        });
        if (!permanent) await deps.sleep(backoffMs(attempt));
        break;
      }

      case "dispatch-conversion": {
        if (!envelope) throw new Error("suppression: dispatch decided without an envelope");
        const key = idempotencyKey(campaignId, claimId, platform, "conversion");
        const outcome = await deps.adapter.sendConversion({
          idempotencyKey: key,
          eventId: conversionEventId(key),
          // The merchant's conversion time and the merchant's order value, both
          // signed into the envelope. Nothing here is derived from the campaign
          // payout, which is a publisher commission and not a purchase.
          occurredAtUnix: Math.floor(Date.parse(envelope.occurredAt) / 1000),
          order: envelope.order,
          subject: envelope.subject,
          dryRun: policy.dryRun,
        });
        outcomes.push(redactOutcome(outcome));
        await settle(deps, claim, outcome, "CONVERSION_ACCEPTED", attempt);
        break;
      }

      case "add-to-audience": {
        if (!envelope) throw new Error("suppression: audience write decided without an envelope");
        const outcome = await deps.adapter.addToExclusionAudience({
          idempotencyKey: idempotencyKey(campaignId, claimId, platform, "audience"),
          subject: envelope.subject,
          dryRun: policy.dryRun,
        });
        outcomes.push(redactOutcome(outcome));
        // The moment the platform takes responsibility for the buyer. This, not
        // the conversion dispatch, is what the SLA is asserted against.
        if (accepted(outcome)) audienceAcceptedAt = stamp();
        await settle(deps, claim, outcome, "AUDIENCE_ACCEPTED", attempt);
        break;
      }

      case "verify-exclusion": {
        const outcome = await deps.adapter.verifyExclusionConfiguration({
          idempotencyKey: idempotencyKey(campaignId, claimId, platform, "exclusion-check"),
          dryRun: policy.dryRun,
        });
        outcomes.push(redactOutcome(outcome));

        // A dry run did not look, which is not an operational failure and must
        // not raise a dead letter. It is recorded as an absence of evidence,
        // and `deriveStatus` refuses to call that a completion.
        if (policy.dryRun) {
          record(deps, claim, "EXCLUSION_UNVERIFIED", attempt, {
            outcome: redactOutcome(outcome),
          });
          break;
        }

        // A response the platform served happily is not the same as a
        // configuration that excludes the buyer. Anything short of every
        // declared target ad set confirmed excluding is recorded as a failure,
        // which lands the receipt on PARTIAL rather than COMPLETED.
        if (accepted(outcome) && !exclusionIsComplete(outcome.coverage)) {
          record(deps, claim, "FAILED_PERMANENT", attempt, {
            failure: { permanent: true, code: "EXCLUSION_INCOMPLETE" },
            outcome: redactOutcome(outcome),
          });
          break;
        }
        if (accepted(outcome) && outcome.configurationDigest) {
          exclusionDigest = outcome.configurationDigest;
        }
        await settle(deps, claim, outcome, "EXCLUSION_VERIFIED", attempt);
        break;
      }

      case "sign-receipt": {
        const intent = store.intent(campaignId, claimId, platform);
        const body = buildReceiptBody({
          claim,
          platform,
          executionMode: executionModeFor(policy),
          status: action.status,
          subjectCommitment: provenCommitment ?? UNIDENTIFIED_SUBJECT,
          conversionRequestId: idempotencyKey(campaignId, claimId, platform, "conversion"),
          suppressionRequestId: idempotencyKey(campaignId, claimId, platform, "audience"),
          observedAt: intent?.at ?? stamp(),
          acceptedAt: audienceAcceptedAt,
          // Absent a completed check the field says so, rather than defaulting
          // to something a reader could mistake for a verified configuration.
          exclusionConfigurationHash: exclusionDigest ?? "unverified",
          outcomes,
          signer: deps.signer.address,
        });
        const receipt = await signReceipt(body, deps.signer);
        store.append({ type: "receipt", at: stamp(), receipt });

        // A permanent failure is the operational signal, whether or not part of
        // the work landed. A PARTIAL receipt still means someone must look.
        if (state.reached.has("FAILED_PERMANENT")) {
          store.append({
            type: "dead-letter",
            at: stamp(),
            campaignId,
            claimId,
            platform,
            code: state.lastFailure?.code ?? "UNKNOWN",
            attempts: state.attempts,
          });
        }
        return receipt;
      }
    }
  }

  throw new Error(`suppression: claim ${campaignId}:${claimId} did not converge`);
}

function accepted(outcome: AdapterOutcome): boolean {
  return outcome.kind === "accepted" || outcome.kind === "processed";
}

/**
 * Translate one adapter outcome into a durable transition.
 *
 * An `unknown` result is never treated as either success or failure: it is
 * recorded as retryable so the next attempt re-sends the same idempotency key
 * and lets the platform, which is the only party that knows, decide whether the
 * first request landed.
 */
async function settle(
  deps: RunnerDeps,
  claim: VerifiedClaim,
  outcome: RedactableOutcome,
  onSuccess: LifecycleState,
  attempt: number,
): Promise<void> {
  if (accepted(outcome)) {
    record(deps, claim, onSuccess, attempt, { outcome: redactOutcome(outcome) });
    return;
  }
  const retryable = outcome.failure?.retryable === true;
  record(deps, claim, retryable ? "RETRY_SCHEDULED" : "FAILED_PERMANENT", attempt, {
    failure: { permanent: !retryable, code: outcome.failure?.code ?? "UNKNOWN" },
    outcome: redactOutcome(outcome),
  });
  if (retryable) await deps.sleep(backoffMs(attempt));
}

function record(
  deps: RunnerDeps,
  claim: VerifiedClaim,
  state: LifecycleState,
  attempt: number,
  extra: Partial<
    Pick<
      TransitionRecord,
      "failure" | "skipReason" | "outcome" | "subjectCommitment" | "envelopeFingerprint"
    >
  > = {},
): void {
  deps.store.append({
    type: "transition",
    at: new Date(deps.now()).toISOString(),
    campaignId: claim.campaignId,
    claimId: claim.claimId,
    platform: deps.policy.platform,
    state,
    attempt,
    ...extra,
  });
}
