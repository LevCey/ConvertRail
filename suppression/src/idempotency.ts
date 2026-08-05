import { keccak256, stringToHex } from "viem";
import type { ExecutionMode, SuppressionPlatform } from "./types.ts";

export type SuppressionAction = "conversion" | "audience" | "exclusion-check";

const VERSION = "v1";

/**
 * `campaignId:claimId:platform:action:v1`
 *
 * Derived, never generated. Every retry of the same action produces the same
 * key, which is the only thing standing between a retry and a duplicate
 * conversion or a double audience write. The version suffix exists so that a
 * deliberate change of semantics gets a new key space instead of silently
 * colliding with records written under the old meaning.
 */
export function idempotencyKey(
  campaignId: string,
  claimId: string,
  platform: SuppressionPlatform,
  action: SuppressionAction,
): string {
  const parts = [campaignId, claimId, platform, action, VERSION];
  for (const part of parts) {
    if (part.length === 0) throw new Error("idempotencyKey: empty component");
    if (part.includes(":")) throw new Error(`idempotencyKey: component contains separator: ${part}`);
  }
  return parts.join(":");
}

/**
 * The platform-facing deduplication id for a conversion.
 *
 * Ad platforms deduplicate on their own event id, not on ours, and they expect
 * an opaque token rather than a structured key. This is a pure function of the
 * idempotency key so a retry after an unknown result re-sends the identical id
 * and the platform collapses it, instead of booking a second purchase.
 */
export function conversionEventId(key: string): string {
  return keccak256(stringToHex(`convertrail:suppression:event:${key}`)).slice(2, 34);
}

/** Stable id for one (claim, platform, execution mode) receipt. The mode is in
 * the seed so a dry run and a live submission for the same claim can never
 * collide, and one can never be filed as evidence of the other. */
export function receiptId(
  campaignId: string,
  claimId: string,
  platform: SuppressionPlatform,
  executionMode: ExecutionMode,
): string {
  const seed = `convertrail:suppression:receipt:${campaignId}:${claimId}:${platform}:${executionMode}:${VERSION}`;
  return `sr_${keccak256(stringToHex(seed)).slice(2, 26)}`;
}
