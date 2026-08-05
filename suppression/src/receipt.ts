import { canonicalJSON } from "@convertrail/shared";
import { getAddress, isAddressEqual, recoverMessageAddress, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { assertSafeToPersist, digest } from "./redaction.ts";
import { receiptId as deriveReceiptId } from "./idempotency.ts";
import { UNIDENTIFIED_SUBJECT } from "./types.ts";
import type {
  ExecutionMode,
  ReceiptStatus,
  SuppressionPlatform,
  SuppressionReceipt,
  SuppressionReceiptBody,
  VerifiedClaim,
} from "./types.ts";

export const RECEIPT_VERSION = "convertrail.suppression.receipt/1";

/**
 * Domain separator.
 *
 * The signing key is the same kind of secp256k1 key that signs chain
 * transactions, so a receipt preimage must never be mistakable for anything
 * else that key signs. The prefix and the version line make that explicit, and
 * bumping the version invalidates every old signature by construction rather
 * than by policy.
 */
const SIGNING_PREFIX = "ConvertRail Suppression Receipt v1";

export interface ReceiptInput {
  claim: VerifiedClaim;
  platform: SuppressionPlatform;
  executionMode: ExecutionMode;
  status: ReceiptStatus;
  subjectCommitment: string;
  conversionRequestId: string;
  suppressionRequestId: string;
  observedAt: string;
  acceptedAt: string | null;
  exclusionConfigurationHash: string;
  /** Redacted adapter outcomes, in the order they occurred. */
  outcomes: unknown[];
  signer: string;
}

/**
 * A receipt may not describe work in a mode other than the one it ran in.
 *
 * `dryRun` markers are stamped on every adapter outcome by the adapter itself,
 * so this compares the declared mode against what the outcomes actually record.
 * The dangerous direction is a `live` receipt built from simulated work — that
 * is a document asserting a submission that never left the process — but the
 * reverse is checked too, since a `dry-run` receipt over real outcomes would
 * understate a live effect on someone's ad account.
 */
function assertModeMatchesOutcomes(mode: ExecutionMode, outcomes: unknown[]): void {
  let simulated = 0;
  let real = 0;
  for (const outcome of outcomes) {
    const detail = (outcome as { detail?: { dryRun?: unknown } } | undefined)?.detail;
    if (detail?.dryRun === true) simulated++;
    else if (detail !== undefined && detail !== null) real++;
  }
  if (mode === "live" && simulated > 0) {
    throw new Error("buildReceiptBody: refusing to sign a live receipt over simulated outcomes");
  }
  if (mode === "dry-run" && real > 0) {
    throw new Error("buildReceiptBody: refusing to sign a dry-run receipt over live outcomes");
  }
}

export function buildReceiptBody(input: ReceiptInput): SuppressionReceiptBody {
  assertModeMatchesOutcomes(input.executionMode, input.outcomes);

  // A receipt that reports work done reports it for someone. The placeholder is
  // only honest when nothing was submitted at all; anywhere else it would be a
  // completed document bound to no buyer, which is precisely the shape a reader
  // would take as proof.
  if (
    input.subjectCommitment === UNIDENTIFIED_SUBJECT &&
    (input.status === "COMPLETED" || input.status === "PARTIAL")
  ) {
    throw new Error(
      `buildReceiptBody: refusing to sign a ${input.status} receipt without a proven subject commitment`,
    );
  }
  const body: SuppressionReceiptBody = {
    version: RECEIPT_VERSION,
    // The mode is part of the identity. A dry run and a live submission for the
    // same claim are different documents and must never share an id, or one
    // could be filed as evidence of the other.
    receiptId: deriveReceiptId(
      input.claim.campaignId,
      input.claim.claimId,
      input.platform,
      input.executionMode,
    ),
    campaignId: input.claim.campaignId,
    claimId: input.claim.claimId,
    evidenceHash: input.claim.evidenceHash,
    platform: input.platform,
    executionMode: input.executionMode,
    trigger: "VERIFIED",
    verifiedAtBlock: input.claim.verifiedAtBlock,
    subjectCommitment: input.subjectCommitment,
    conversionRequestId: input.conversionRequestId,
    suppressionRequestId: input.suppressionRequestId,
    observedAt: input.observedAt,
    acceptedAt: input.acceptedAt,
    exclusionConfigurationHash: input.exclusionConfigurationHash,
    status: input.status,
    responseDigest: digest(input.outcomes),
    signer: getAddress(input.signer),
  };
  assertSafeToPersist(body, "buildReceiptBody");
  return body;
}

/**
 * The exact bytes that get signed. Exported because a third party verifying a
 * receipt must reconstruct this from the body alone — if verification needed
 * anything we hold privately, the receipt would not be evidence.
 */
export function receiptPreimage(body: SuppressionReceiptBody): string {
  return `${SIGNING_PREFIX}\n${canonicalJSON(body)}`;
}

export async function signReceipt(
  body: SuppressionReceiptBody,
  account: LocalAccount,
): Promise<SuppressionReceipt> {
  if (!isAddressEqual(getAddress(body.signer), account.address)) {
    throw new Error("signReceipt: body.signer does not match the signing account");
  }
  const signature = await account.signMessage({ message: receiptPreimage(body) });
  return { ...body, signature };
}

export type VerificationResult =
  | { valid: true; signer: Hex }
  | { valid: false; reason: string; recovered?: Hex };

/**
 * Cold verification: address and receipt in, verdict out. No network, no
 * database, no shared secret. Any field the signer changes — a status upgraded
 * from PARTIAL to COMPLETED, a timestamp pulled inside the SLA — moves the
 * recovered address and fails here.
 */
export async function verifyReceipt(receipt: SuppressionReceipt): Promise<VerificationResult> {
  const { signature, ...body } = receipt;
  if (!signature) return { valid: false, reason: "missing signature" };
  if (body.version !== RECEIPT_VERSION) {
    return { valid: false, reason: `unsupported receipt version ${body.version}` };
  }

  let expected: Hex;
  try {
    expected = getAddress(body.signer);
  } catch {
    return { valid: false, reason: "malformed signer address" };
  }

  let recovered: Hex;
  try {
    recovered = await recoverMessageAddress({
      message: receiptPreimage(body as SuppressionReceiptBody),
      signature,
    });
  } catch (error) {
    return { valid: false, reason: `signature not recoverable: ${(error as Error).message}` };
  }

  if (!isAddressEqual(recovered, expected)) {
    return { valid: false, reason: "signature does not match the declared signer", recovered };
  }
  return { valid: true, signer: recovered };
}
