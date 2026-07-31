// Pure decision core: (claim, evidence, config, rate state) -> verdict.
// Deterministic by construction — identical inputs produce identical
// verdicts (R6.2). No I/O, no clock reads: callers pass every input.
import type { Address, Hex } from "viem";
import {
  evidenceHash,
  nullifier,
  type SignedConversionEvent,
  type VerificationPolicy,
  type RejectReasonName,
} from "@convertrail/shared";

export interface ClaimInput {
  campaignId: Hex;
  publisher: Address;
  nullifier: Hex;
  evidenceHash: Hex;
}

/**
 * A funding-graph relationship between the claimant and another participant in
 * the same campaign, resolved from chain by the caller. Resolving it is I/O and
 * therefore does not belong in this module (R6.2).
 */
export interface FundingLink {
  /** The other campaign participant the claimant resolves to. */
  counterparty: Address;
  /** 1 = counterparty funded the claimant directly; 2 = both were funded by
   *  the same non-hub address. */
  hops: number;
  /** The shared funder, when `hops` is 2. */
  via?: Address;
}

export type Verdict = { approved: true } | { approved: false; reason: Exclude<RejectReasonName, "NONE"> };

/**
 * @param claim         claim fields as read from chain
 * @param event         the signed merchant event found by evidence hash, or null
 * @param binding       publisherId -> on-chain address map (from config)
 * @param policy        the published verification policy (hash committed on-chain)
 * @param priorClaimsMs submission timestamps (ms) of this publisher's prior
 *                      claims inside the rate window, excluding this claim
 * @param fundingLink   funding-graph link from this claimant to another
 *                      participant, or null if the caller found none
 */
export function decide(
  claim: ClaimInput,
  event: SignedConversionEvent | null,
  binding: Record<string, Address>,
  policy: VerificationPolicy,
  priorClaimsMs: number[],
  fundingLink: FundingLink | null,
): Verdict {
  if (event === null) {
    return { approved: false, reason: "EVIDENCE_MISMATCH" };
  }
  if (evidenceHash(event) !== claim.evidenceHash) {
    return { approved: false, reason: "EVIDENCE_MISMATCH" };
  }
  if (event.campaignId !== claim.campaignId) {
    return { approved: false, reason: "EVIDENCE_MISMATCH" };
  }
  // The nullifier must be derived from this exact conversion — a fresh
  // nullifier pointing at someone else's evidence is a stolen conversion.
  if (nullifier(claim.campaignId, event.conversionId) !== claim.nullifier) {
    return { approved: false, reason: "EVIDENCE_MISMATCH" };
  }
  const boundAddress = binding[event.publisherId];
  if (!boundAddress || boundAddress.toLowerCase() !== claim.publisher.toLowerCase()) {
    return { approved: false, reason: "EVIDENCE_MISMATCH" };
  }
  // Identity integrity. The claim is now known to reference a genuine event by
  // a bound publisher, so the remaining question is whether that publisher is
  // an independent party. A second identity funded out of another
  // participant's wallet is the same operator referring itself; the evidence
  // and the timing of such a claim are perfectly real, which is exactly why no
  // other rule catches it.
  if (fundingLink !== null && fundingLink.hops <= policy.maxFundingLinkHops) {
    return { approved: false, reason: "LINKED_PUBLISHER" };
  }
  if (event.conversionTs < event.clickTs) {
    return { approved: false, reason: "MALFORMED_EVIDENCE" };
  }
  if (event.conversionTs - event.clickTs < policy.minClickToConversionMs) {
    return { approved: false, reason: "TIMING_ANOMALY" };
  }
  if (priorClaimsMs.length >= policy.maxClaimsPerWindow) {
    return { approved: false, reason: "RATE_ANOMALY" };
  }
  return { approved: true };
}
