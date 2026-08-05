import type { Hex } from "viem";

/** Ad platforms the module can address. Only `mock` and `meta` have
 * implementations; the rest are interface-level so the core stays free of
 * platform branching. */
export type SuppressionPlatform = "mock" | "meta" | "google" | "tiktok";

/** What the module was told to do about a claim. Fine-grained and persisted —
 * every transition is written before the next external call, so a crash leaves
 * a readable position rather than a guess. */
export type LifecycleState =
  | "INTENT_RECORDED"
  | "RETRY_SCHEDULED"
  | "ENVELOPE_FETCHED"
  | "CONVERSION_ACCEPTED"
  | "AUDIENCE_ACCEPTED"
  | "EXCLUSION_VERIFIED"
  | "EXCLUSION_UNVERIFIED"
  | "RECEIPT_SIGNED"
  | "SKIPPED"
  | "FAILED_PERMANENT"
  | "AMENDED";

/**
 * What a third party reads off the receipt. Coarse on purpose.
 *
 * `PARTIAL` is not a hedge: a conversion the platform accepted while the
 * audience mutation failed is neither a success nor a failure, and collapsing
 * it into either would overstate or understate what happened. The product's
 * whole claim rests on not doing that.
 */
export type ReceiptStatus = "COMPLETED" | "PARTIAL" | "FAILED" | "SKIPPED";

export type SkipReason =
  | "SUPPRESSION_DISABLED"
  | "NO_CONSENT"
  | "NO_SUBJECT"
  | "CLAIM_NOT_VERIFIED";

/**
 * Normalised, platform-ready identifiers for one buyer.
 *
 * These are personal data even though they are hashed. A SHA-256 of an email is
 * a stable, unkeyed pseudonym: anyone holding a candidate address confirms a
 * match in one hash, and every advertiser on the same platform derives the
 * identical value for the same person. So this type refuses to serialise and
 * refuses to print. An adapter that genuinely needs the values calls
 * `forPlatform()` deliberately; everything else gets a redaction marker.
 *
 * This is a structural control, not a convention: `JSON.stringify` on anything
 * containing one of these throws rather than leaking.
 */
export class PlatformSubject {
  readonly #fields: Readonly<Record<string, string>>;

  constructor(fields: Record<string, string>) {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined && v !== "");
    if (entries.length === 0) throw new Error("PlatformSubject: at least one identifier is required");
    this.#fields = Object.freeze(Object.fromEntries(entries));
  }

  /** Explicit, auditable access. The only way to read the values. */
  forPlatform(): Readonly<Record<string, string>> {
    return this.#fields;
  }

  /** Which identifier kinds are present — safe to log, reveals no value. */
  presentKinds(): string[] {
    return Object.keys(this.#fields).sort();
  }

  toJSON(): never {
    throw new Error(
      "PlatformSubject must not be serialised: hashed contact identifiers are personal data",
    );
  }

  toString(): string {
    return "[PlatformSubject redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[PlatformSubject redacted]";
  }
}

/** The only consent purpose this module will act on. A merchant that recorded
 * consent for something else has not authorised an advertising suppression. */
export const SUPPRESSION_CONSENT_PURPOSE = "advertising-suppression";

/**
 * What the buyer actually paid the merchant.
 *
 * Deliberately separate from the campaign's per-conversion affiliate
 * commission, which is a payout to a publisher denominated in atomic USDC and
 * has nothing to do with the purchase an ad platform is being told about.
 * `null` when the merchant does not model an order value — omitting the figure
 * is correct, inventing one is not.
 */
export interface OrderValue {
  /** Decimal major units, e.g. "49.99". Never atomic units. */
  value: string;
  /** ISO 4217, e.g. "USD". */
  currency: string;
}

/** Merchant-issued, short-lived, bound to one verified claim. */
export interface SuppressionEnvelope {
  version: string;
  evidenceHash: Hex;
  /** Opaque merchant-scoped reference. Never a raw identifier. */
  subjectRef: string;
  subject: PlatformSubject;
  /** When the purchase happened, per the merchant's own record. The platform
   * needs the conversion's time, not the time we got around to submitting it. */
  occurredAt: string;
  order: OrderValue | null;
  consent: { granted: boolean; purpose: string; recordedAt: string };
  expiresAt: string;
  merchantSignature: Hex;
}

/**
 * Which of the three worlds a receipt was produced in.
 *
 * Signed, so it cannot be stripped by whoever forwards the receipt. Without it
 * a dry run against Meta and a real submission are textually identical
 * documents, and the difference between them is the entire claim.
 */
export type ExecutionMode = "live" | "dry-run" | "mock";

/**
 * Stands in for the commitment on receipts where no buyer was ever established
 * — a disabled policy, or an envelope that could not be obtained at all.
 *
 * Permitted only when nothing was submitted. A receipt reporting `COMPLETED` or
 * `PARTIAL` describes work done for a specific person, and pairing that with a
 * placeholder would be a document bound to nobody. `buildReceiptBody` refuses
 * that combination.
 */
export const UNIDENTIFIED_SUBJECT = "no-subject-established";

/**
 * What an exclusion check established, against an explicitly configured target
 * scope.
 *
 * `targeted` is the number of acquisition ad sets the operator declared must
 * exclude the audience. Without that declaration there is no denominator, and a
 * check that inspects whatever it happens to find can report "everything we saw
 * excludes the buyer" while the campaign that mattered was never looked at.
 *
 * `unresolved` names configured targets that could not be inspected at all —
 * deleted, renamed, or in an account the token cannot read. Those are neither
 * excluding nor confirmed absent, and collapsing them into either would be a
 * claim we cannot support.
 */
export interface ExclusionCoverage {
  targeted: number;
  observed: number;
  excluding: number;
  unresolved: string[];
}

/** The verified claim as read from chain. */
export interface VerifiedClaim {
  campaignId: Hex;
  claimId: string;
  evidenceHash: Hex;
  verifiedAtBlock: string;
}

export interface SuppressionPolicy {
  platform: SuppressionPlatform;
  /** v1 is VERIFIED only; SETTLED is a documented future option. */
  trigger: "VERIFIED";
  enabled: boolean;
  dryRun: boolean;
  /** Attempt budget for the whole claim, not per action. A claim that burns its
   * budget re-fetching an envelope has none left to dispatch with, which is the
   * intended behaviour: the bound is on how much work one claim may cost. */
  maxAttempts: number;
  slaSeconds: number;
}

/** Accumulated, replayable state for one (claim, platform). */
export interface SuppressionState {
  reached: Set<LifecycleState>;
  attempts: number;
  lastFailure?: { permanent: boolean; code: string } | undefined;
  skipReason?: SkipReason | undefined;
}

export interface SuppressionReceiptBody {
  version: string;
  receiptId: string;
  campaignId: Hex;
  claimId: string;
  evidenceHash: Hex;
  platform: SuppressionPlatform;
  executionMode: ExecutionMode;
  trigger: "VERIFIED";
  /** The chain anchor for the SLA. `observedAt` can only lag it; publishing the
   * block lets a third party recompute true latency from the source rather than
   * trusting our clock. */
  verifiedAtBlock: string;
  subjectCommitment: string;
  conversionRequestId: string;
  suppressionRequestId: string;
  /**
   * When ConvertRail observed the verified claim and took responsibility for it
   * — the `at` of the intent record, written before any platform contact.
   *
   * Named for what it is. Calling it `requestedAt` implied it marked the start
   * of an audience request, and the figure derived from it would then have read
   * as request-to-acceptance latency while actually measuring
   * observation-to-acceptance. Between them sits the envelope fetch and any
   * retries, which is exactly the interval a suppression product should not
   * quietly drop from its own latency figure.
   */
  observedAt: string;
  acceptedAt: string | null;
  exclusionConfigurationHash: string;
  status: ReceiptStatus;
  responseDigest: string;
  signer: string;
}

export interface SuppressionReceipt extends SuppressionReceiptBody {
  signature: Hex;
}
