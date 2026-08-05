import type {
  ExclusionCoverage,
  ExecutionMode,
  LifecycleState,
  ReceiptStatus,
  SkipReason,
  SuppressionEnvelope,
  SuppressionPolicy,
  SuppressionState,
  VerifiedClaim,
} from "./types.ts";

/**
 * The decision core. Pure: no clock, no network, no adapter, no platform
 * branch. `nowMs` is passed in rather than read so that expiry behaviour is
 * testable at an exact instant.
 *
 * The runner is a loop — apply the action, record the resulting lifecycle
 * state, ask again. That keeps every transition durable and makes a crash
 * resume from the store rather than from a half-finished in-memory plan.
 */
export type AbortCode = "EVIDENCE_HASH_MISMATCH" | "ENVELOPE_EXPIRED" | "ATTEMPTS_EXHAUSTED";

export type NextAction =
  | { kind: "fetch-envelope" }
  | { kind: "dispatch-conversion" }
  | { kind: "add-to-audience" }
  | { kind: "verify-exclusion" }
  | { kind: "sign-receipt"; status: ReceiptStatus }
  | { kind: "skip"; reason: SkipReason }
  | { kind: "abort"; code: AbortCode }
  | { kind: "done" };

export function emptyState(): SuppressionState {
  return { reached: new Set<LifecycleState>(), attempts: 0 };
}

/**
 * What the receipt will say.
 *
 * `PARTIAL` covers the case the product exists to be honest about: the platform
 * accepted the conversion but the audience mutation or the configuration check
 * did not complete. Reporting that as success would assert an exclusion we
 * never established.
 */
export function deriveStatus(state: SuppressionState): ReceiptStatus {
  if (state.skipReason) return "SKIPPED";
  const { reached } = state;
  const conversion = reached.has("CONVERSION_ACCEPTED");
  const audience = reached.has("AUDIENCE_ACCEPTED");
  const exclusion = reached.has("EXCLUSION_VERIFIED");
  if (conversion && audience && exclusion) return "COMPLETED";
  if (!conversion && !audience) return "FAILED";
  return "PARTIAL";
}

export function decideNext(
  claim: VerifiedClaim,
  envelope: SuppressionEnvelope | null,
  state: SuppressionState,
  policy: SuppressionPolicy,
  nowMs: number,
): NextAction {
  const { reached } = state;

  if (reached.has("RECEIPT_SIGNED")) return { kind: "done" };

  // Terminal states still produce a receipt: an advertiser asking "what happened
  // to this buyer?" is owed an answer for skips and failures too.
  if (reached.has("SKIPPED") || reached.has("FAILED_PERMANENT")) {
    return { kind: "sign-receipt", status: deriveStatus(state) };
  }

  if (!policy.enabled) return { kind: "skip", reason: "SUPPRESSION_DISABLED" };

  if (state.lastFailure?.permanent || state.attempts >= policy.maxAttempts) {
    return { kind: "abort", code: "ATTEMPTS_EXHAUSTED" };
  }

  // What is left to do is decided before whether an envelope is needed for it.
  //
  // The other way round — establishing the envelope first, then choosing the
  // step — makes every remaining step depend on the merchant being reachable,
  // including the ones that have nothing to do with buyer identity. On a resume
  // after the audience write, an unreachable merchant would then block the
  // exclusion check and record a permanent failure against a claim whose only
  // outstanding work needed no identity at all.
  const needsConversion = !reached.has("CONVERSION_ACCEPTED");
  const needsAudience = !reached.has("AUDIENCE_ACCEPTED");

  if (needsConversion || needsAudience) {
    // Both remaining steps send the buyer to a platform, so both need the
    // envelope, and it is validated before either of them is chosen.
    if (!reached.has("ENVELOPE_FETCHED") || envelope === null) {
      return { kind: "fetch-envelope" };
    }
    // The envelope is the only thing binding a buyer identity to this claim. If
    // it is bound to a different claim, nothing downstream is trustworthy.
    if (envelope.evidenceHash.toLowerCase() !== claim.evidenceHash.toLowerCase()) {
      return { kind: "abort", code: "EVIDENCE_HASH_MISMATCH" };
    }
    if (!envelope.consent.granted) return { kind: "skip", reason: "NO_CONSENT" };
    if (Date.parse(envelope.expiresAt) <= nowMs) return { kind: "abort", code: "ENVELOPE_EXPIRED" };

    return needsConversion ? { kind: "dispatch-conversion" } : { kind: "add-to-audience" };
  }

  // Reading the advertiser's own ad set configuration involves no buyer, so it
  // runs without an envelope and cannot be held up by a merchant outage.
  //
  // `EXCLUSION_UNVERIFIED` closes the step without standing in for a pass:
  // `deriveStatus` requires `EXCLUSION_VERIFIED` for a completion, so a run that
  // did not look lands on PARTIAL.
  if (!reached.has("EXCLUSION_VERIFIED") && !reached.has("EXCLUSION_UNVERIFIED")) {
    return { kind: "verify-exclusion" };
  }

  // Everything that was going to happen has happened. Nothing here calls the
  // merchant or an adapter again.
  return { kind: "sign-receipt", status: deriveStatus(state) };
}

/**
 * Whether an exclusion check established what a `COMPLETED` receipt asserts.
 *
 * Every clause is load-bearing, and each one corresponds to a way the check can
 * look successful while proving nothing:
 *
 * - `targeted > 0` — an empty target scope makes the ratio 0/0, which is not
 *   evidence of anything. A check with nothing to check must not pass.
 * - `observed === targeted` — every declared ad set was actually read back.
 * - `excluding === targeted` — and every one of them excludes the audience.
 *   Partial coverage is a real state and it is not completion.
 * - `unresolved` empty — a target we could not inspect is not a target we
 *   confirmed.
 *
 * Platform-neutral by construction: it reads a coverage record, not an API.
 */
export function exclusionIsComplete(coverage: ExclusionCoverage | undefined): boolean {
  if (!coverage) return false;
  return (
    coverage.targeted > 0 &&
    coverage.observed === coverage.targeted &&
    coverage.excluding === coverage.targeted &&
    coverage.unresolved.length === 0
  );
}

/**
 * The mode a receipt may honestly claim.
 *
 * A mock adapter never touched a platform, and a dry run never sent the
 * request it describes. Both produce useful records, but neither may be
 * presented as a live submission, so the mode is derived here once rather than
 * inferred by each caller.
 */
export function executionModeFor(policy: SuppressionPolicy): ExecutionMode {
  if (policy.platform === "mock") return "mock";
  return policy.dryRun ? "dry-run" : "live";
}

/**
 * Observation to acceptance, against the campaign's SLA.
 *
 * The clock starts when ConvertRail observed the verified claim and stops when
 * the platform accepted the audience submission. Deliberately not measured from
 * payment — the two paths are independent — and deliberately not claimed to
 * start at chain verification, which we cannot see without the block's
 * timestamp. `verifiedAtBlock` on the receipt lets a reader take that half from
 * the chain.
 */
export function withinSla(
  observedAtMs: number,
  acceptedAtMs: number | null,
  policy: SuppressionPolicy,
): boolean {
  if (acceptedAtMs === null) return false;
  return acceptedAtMs - observedAtMs <= policy.slaSeconds * 1000;
}
