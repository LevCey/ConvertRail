import { concat, isHex, keccak256, stringToBytes, toBytes, type Hex } from "viem";
import { canonicalJSON } from "./canonical.ts";

/**
 * Nullifier for a conversion claim: keccak256(campaignId ++ utf8(conversionId)).
 * campaignId is fixed-width (bytes32), so the concatenation is unambiguous.
 * The contract never recomputes this — it only enforces uniqueness of the
 * resulting bytes32 per campaign — so agents, the fraud script, and tests
 * are the parties that must agree on this exact construction.
 */
export function nullifier(campaignId: Hex, conversionId: string): Hex {
  assertBytes32(campaignId, "campaignId");
  if (conversionId.length === 0) {
    throw new Error("nullifier: conversionId must be non-empty");
  }
  return keccak256(concat([toBytes(campaignId), stringToBytes(conversionId)]));
}

/**
 * Evidence hash for a claim: keccak256 of the canonical JSON serialization
 * of the full signed conversion event (signature included).
 */
export function evidenceHash(signedEvent: unknown): Hex {
  return keccak256(stringToBytes(canonicalJSON(signedEvent)));
}

function assertBytes32(value: Hex, name: string): void {
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex string`);
  }
}
