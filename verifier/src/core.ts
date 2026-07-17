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
} from "@proof-of-conversion/shared";

export interface ClaimInput {
  campaignId: Hex;
  publisher: Address;
  nullifier: Hex;
  evidenceHash: Hex;
}

export type Verdict = { approved: true } | { approved: false; reason: Exclude<RejectReasonName, "NONE"> };

/**
 * @param claim         claim fields as read from chain
 * @param event         the signed merchant event found by evidence hash, or null
 * @param binding       publisherId -> on-chain address map (from config)
 * @param policy        the published verification policy (hash committed on-chain)
 * @param priorClaimsMs submission timestamps (ms) of this publisher's prior
 *                      claims inside the rate window, excluding this claim
 */
export function decide(
  claim: ClaimInput,
  event: SignedConversionEvent | null,
  binding: Record<string, Address>,
  policy: VerificationPolicy,
  priorClaimsMs: number[],
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
