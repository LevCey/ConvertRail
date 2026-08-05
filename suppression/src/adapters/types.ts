import type { ExclusionCoverage, PlatformSubject, SuppressionPlatform } from "../types.ts";

/**
 * Outcome classification, shared by every adapter.
 *
 * `accepted` and `processed` are separate on purpose. A platform returning 200
 * for a conversion event or an audience addition has accepted a request; it has
 * not necessarily finished matching the identifier into the audience, and it
 * certainly has not changed ad delivery. Collapsing these is how a suppression
 * product ends up claiming something it never observed.
 *
 * There is deliberately no `delivered`. We do not observe delivery, so no
 * adapter is given a way to report it.
 */
export type OutcomeKind = "accepted" | "processed" | "rejected" | "unknown";

export type FailureClass =
  | "transport"
  | "throttle"
  | "transient"
  | "validation"
  | "authorisation"
  | "unknown";

/**
 * Optional fields are written `?: T | undefined` throughout this module rather
 * than the shorter `?: T`.
 *
 * Not pedantry: `canonicalJSON` throws on an `undefined` value, so a record
 * built as `{ failure: maybeUndefined }` fails at persist time while an absent
 * key serialises fine. Under `exactOptionalPropertyTypes` those two are
 * different types, and the compiler catches the difference before the store
 * does.
 */
export interface AdapterOutcome {
  kind: OutcomeKind;
  /** Platform-side identifier for the request, where one is returned. */
  platformRef?: string | undefined;
  /** Redacted, digestible summary. Never a raw response body. */
  detail: Record<string, string | number | boolean>;
  failure?: { class: FailureClass; code: string; retryable: boolean } | undefined;
}

export interface ConversionDispatchInput {
  idempotencyKey: string;
  /** Deterministic platform deduplication key. Reused verbatim on retry — a
   * regenerated id turns a retry into a duplicate conversion. */
  eventId: string;
  /** The merchant's conversion time, not ours. Sending the submission time
   * would misplace every event on the platform's timeline. */
  occurredAtUnix: number;
  /**
   * The purchase as the merchant recorded it, or `null` when they do not model
   * one. Never the campaign's per-conversion affiliate commission: that is a
   * publisher payout in atomic USDC, and reporting it as a purchase would put a
   * fabricated sale figure into the advertiser's own reporting.
   */
  order: { value: string; currency: string } | null;
  subject: PlatformSubject;
  dryRun: boolean;
}

export interface AudienceMutationInput {
  idempotencyKey: string;
  subject: PlatformSubject;
  dryRun: boolean;
}

export interface ExclusionVerificationInput {
  idempotencyKey: string;
  /** A dry run must reach no network at all. Without this the check was the one
   * hole in an otherwise simulated run: two writes withheld, then a real read
   * against the advertiser's account. */
  dryRun: boolean;
}


export interface ConversionDispatchResult extends AdapterOutcome {}
export interface AudienceMutationResult extends AdapterOutcome {}

export interface ExclusionVerificationResult extends AdapterOutcome {
  coverage?: ExclusionCoverage | undefined;
  /** Digest over the sorted, per-ad-set observed configuration — not over the
   * ratio. Two different configurations can share a ratio, and a receipt that
   * commits only to "2 of 3" cannot later be checked against what was actually
   * seen. */
  configurationDigest?: string | undefined;
}

/**
 * The seam. Everything platform-specific lives behind this and nowhere else —
 * the domain core must never branch on which platform it is talking to.
 */
export interface SuppressionAdapter {
  readonly platform: SuppressionPlatform;

  sendConversion(input: ConversionDispatchInput): Promise<ConversionDispatchResult>;

  addToExclusionAudience(input: AudienceMutationInput): Promise<AudienceMutationResult>;

  verifyExclusionConfiguration(
    input: ExclusionVerificationInput,
  ): Promise<ExclusionVerificationResult>;
}

/** Thrown by adapters that exist to define the interface and nothing else. */
export class NotImplementedAdapterError extends Error {
  constructor(platform: SuppressionPlatform) {
    super(`${platform} adapter is interface-only in this version`);
    this.name = "NotImplementedAdapterError";
  }
}
