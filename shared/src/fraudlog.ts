// Rebuilds the fraud log purely from chain events — no service-side state,
// no trust in any off-chain log. A rejected claim's verdict is an on-chain
// event (ClaimRejected); joining it to its ClaimSubmitted event recovers the
// full evidence capsule (nullifier + evidence hash) a third party needs to
// audit the refusal. This is the read-side transform the dashboard renders
// and the integrity check R5.4 asserts.
//
// Scope note: this reconstructs the REJECTED-verdict fraud class from events.
// The duplicate-nullifier class reverts at submit and therefore emits no
// event at all — those attempts are evidenced by failed-transaction receipts
// to the registry (the reverting tx is itself the permanent on-chain record),
// which is a receipt scan, not a log scan, and is handled separately.
import type { Address, Hex } from "viem";
import { REJECT_REASON, type RejectReasonName } from "./contracts.ts";

/** Decoded `ClaimSubmitted(claimId, campaignId, publisher, nullifier, evidenceHash)`. */
export interface SubmittedEventArgs {
  claimId: bigint;
  campaignId: Hex;
  publisher: Address;
  nullifier: Hex;
  evidenceHash: Hex;
}

/** Decoded `ClaimRejected(claimId, campaignId, publisher, reason)`. */
export interface RejectedEventArgs {
  claimId: bigint;
  campaignId: Hex;
  publisher: Address;
  reason: number;
}

export interface FraudLogEntry {
  claimId: bigint;
  campaignId: Hex;
  publisher: Address;
  nullifier: Hex;
  evidenceHash: Hex;
  reason: RejectReasonName;
}

const REASON_NAME: Record<number, RejectReasonName> = Object.fromEntries(
  Object.entries(REJECT_REASON).map(([name, code]) => [code, name as RejectReasonName]),
);

/**
 * Joins each ClaimRejected event to its originating ClaimSubmitted event to
 * produce the ordered fraud log. Pure and deterministic: the same event set
 * always yields the same log (independent of input ordering), so a replay
 * over recorded chain events reproduces exactly what the dashboard showed.
 *
 * A ClaimRejected with no matching ClaimSubmitted (which the contract never
 * produces — a verdict presupposes a submitted claim) is skipped rather than
 * fabricated, so the log never contains an entry not backed by chain state.
 */
export function reconstructFraudLog(
  submitted: SubmittedEventArgs[],
  rejected: RejectedEventArgs[],
): FraudLogEntry[] {
  const byId = new Map<bigint, SubmittedEventArgs>();
  for (const event of submitted) {
    byId.set(event.claimId, event);
  }

  const entries: FraudLogEntry[] = [];
  for (const verdict of rejected) {
    const claim = byId.get(verdict.claimId);
    if (!claim) continue;
    entries.push({
      claimId: verdict.claimId,
      campaignId: claim.campaignId,
      publisher: claim.publisher,
      nullifier: claim.nullifier,
      evidenceHash: claim.evidenceHash,
      reason: REASON_NAME[verdict.reason] ?? "NONE",
    });
  }

  entries.sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
  return entries;
}
