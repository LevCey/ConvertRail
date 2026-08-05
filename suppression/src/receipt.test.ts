import { strict as assert } from "node:assert";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJSON } from "@convertrail/shared";
import { RECEIPT_VERSION, buildReceiptBody, receiptPreimage, signReceipt, verifyReceipt } from "./receipt.ts";
import { subjectCommitment } from "./redaction.ts";
import type { ReceiptInput } from "./receipt.ts";
import type { SuppressionReceipt, VerifiedClaim } from "./types.ts";

const account = privateKeyToAccount(`0x${"42".repeat(32)}`);
const other = privateKeyToAccount(`0x${"43".repeat(32)}`);

const claim: VerifiedClaim = {
  campaignId: `0x${"ab".repeat(32)}`,
  claimId: "7",
  evidenceHash: `0x${"cd".repeat(32)}`,
  verifiedAtBlock: "55149673",
};

function input(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    claim,
    platform: "mock",
    executionMode: "mock",
    status: "COMPLETED",
    subjectCommitment: subjectCommitment("k".repeat(48), "tenant-a", "subj_synthetic_7"),
    conversionRequestId: `${claim.campaignId}:7:mock:conversion:v1`,
    suppressionRequestId: `${claim.campaignId}:7:mock:audience:v1`,
    observedAt: "2026-08-04T12:00:00.000Z",
    acceptedAt: "2026-08-04T12:00:04.000Z",
    exclusionConfigurationHash: "e".repeat(64),
    outcomes: [{ kind: "accepted", platformRef: "ref_1" }],
    signer: account.address,
    ...overrides,
  };
}

async function signed(overrides: Partial<ReceiptInput> = {}): Promise<SuppressionReceipt> {
  return signReceipt(buildReceiptBody(input(overrides)), account);
}

test("an unmodified receipt verifies against nothing but its own signer address", async () => {
  const receipt = await signed();
  const result = await verifyReceipt(receipt);
  assert.equal(result.valid, true);
  assert.equal(result.valid && result.signer.toLowerCase(), account.address.toLowerCase());
});

test("the receipt id is deterministic per claim and platform", () => {
  assert.equal(buildReceiptBody(input()).receiptId, buildReceiptBody(input()).receiptId);
  assert.notEqual(
    buildReceiptBody(input()).receiptId,
    buildReceiptBody(input({ platform: "meta" })).receiptId,
  );
});

test("the preimage is domain-separated and reconstructible from the body alone", () => {
  const body = buildReceiptBody(input());
  const preimage = receiptPreimage(body);
  assert.equal(preimage.startsWith("ConvertRail Suppression Receipt v1\n"), true);
  assert.equal(preimage.slice(preimage.indexOf("\n") + 1), canonicalJSON(body));
});

test("the preimage is stable under key reordering of the body", () => {
  const body = buildReceiptBody(input());
  const shuffled = Object.fromEntries(Object.entries(body).reverse()) as typeof body;
  assert.equal(receiptPreimage(shuffled), receiptPreimage(body));
});

test("every field is covered by the signature", async () => {
  const receipt = await signed();
  const mutations: Array<[string, unknown]> = [
    ["status", "COMPLETED"],
    ["claimId", "8"],
    ["campaignId", `0x${"ff".repeat(32)}`],
    ["evidenceHash", `0x${"ee".repeat(32)}`],
    ["platform", "meta"],
    ["executionMode", "live"],
    ["trigger", "SETTLED"],
    ["subjectCommitment", "a".repeat(64)],
    ["conversionRequestId", "tampered"],
    ["suppressionRequestId", "tampered"],
    ["observedAt", "2026-08-04T11:00:00.000Z"],
    ["acceptedAt", "2026-08-04T12:00:01.000Z"],
    ["exclusionConfigurationHash", "f".repeat(64)],
    ["responseDigest", "b".repeat(64)],
    ["receiptId", "sr_tampered"],
    ["version", "convertrail.suppression.receipt/2"],
  ];

  for (const [field, value] of mutations) {
    const original = (receipt as unknown as Record<string, unknown>)[field];
    const tampered = { ...receipt, [field]: field === "status" ? "PARTIAL" : value };
    assert.notDeepEqual(tampered[field as keyof SuppressionReceipt], original, `${field} unchanged`);
    const result = await verifyReceipt(tampered as SuppressionReceipt);
    assert.equal(result.valid, false, `tampering with ${field} must not verify`);
  }
});

test("upgrading a partial outcome to completed is rejected", async () => {
  const receipt = await signed({ status: "PARTIAL", acceptedAt: null });
  const upgraded = { ...receipt, status: "COMPLETED" as const };
  assert.equal((await verifyReceipt(upgraded)).valid, false);
});

test("swapping in another signer address is rejected", async () => {
  const receipt = await signed();
  const result = await verifyReceipt({ ...receipt, signer: other.address });
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, "signature does not match the declared signer");
});

test("a body signed by the wrong key cannot claim our address", async () => {
  const body = buildReceiptBody(input());
  await assert.rejects(() => signReceipt(body, other), /does not match the signing account/);
});

test("adding an undeclared field invalidates the receipt", async () => {
  const receipt = await signed();
  const extended = { ...receipt, note: "added later" } as unknown as SuppressionReceipt;
  assert.equal((await verifyReceipt(extended)).valid, false);
});

test("removing a field invalidates the receipt", async () => {
  const receipt = await signed();
  const { acceptedAt, ...without } = receipt;
  assert.equal((await verifyReceipt(without as SuppressionReceipt)).valid, false);
});

test("a missing or malformed signature is rejected without throwing", async () => {
  const receipt = await signed();
  assert.equal((await verifyReceipt({ ...receipt, signature: undefined as never })).valid, false);
  assert.equal((await verifyReceipt({ ...receipt, signature: "0xdead" })).valid, false);
  assert.equal((await verifyReceipt({ ...receipt, signer: "not-an-address" })).valid, false);
});

test("an unknown receipt version is rejected before any recovery is attempted", async () => {
  const receipt = await signed();
  const result = await verifyReceipt({ ...receipt, version: "convertrail.suppression.receipt/2" });
  assert.equal(result.valid, false);
  assert.match(result.valid === false ? result.reason : "", /unsupported receipt version/);
});

test("the body carries no identifier and states the version it commits to", () => {
  const body = buildReceiptBody(input());
  assert.equal(body.version, RECEIPT_VERSION);
  assert.equal(body.trigger, "VERIFIED");
  assert.equal(canonicalJSON(body).includes("@"), false);
});

test("a subject hash placed in a receipt field is refused at build time", () => {
  assert.throws(
    () => buildReceiptBody(input({ conversionRequestId: "9".repeat(64) })),
    /refusing to persist/,
  );
});
