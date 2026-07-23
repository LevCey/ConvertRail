import assert from "node:assert/strict";
import test from "node:test";
import type { Hex } from "viem";
import { parseDuplicateAttempts, parsePaymentRecords, parseRunMetadata } from "./runtime.ts";

const campaign = `0x${"11".repeat(32)}` as Hex;
const otherCampaign = `0x${"22".repeat(32)}` as Hex;
const publisher = `0x${"33".repeat(20)}`;
const tx = `0x${"44".repeat(32)}`;
const nullifier = `0x${"55".repeat(32)}`;
const evidenceHash = `0x${"66".repeat(32)}`;

test("payment records are campaign-bound, validated, and deduplicated", () => {
  const valid = {
    campaignId: campaign,
    claimId: "7",
    publisher,
    amount: "100000",
    ref: "gateway-ref",
    elapsedMs: 281,
    settleTx: tx,
  };
  const parsed = parsePaymentRecords(
    [
      JSON.stringify({ ...valid, campaignId: otherCampaign }),
      "not-json",
      JSON.stringify({ ...valid, amount: "-1" }),
      JSON.stringify(valid),
      JSON.stringify(valid),
    ].join("\n"),
    campaign,
  );
  assert.deepEqual(parsed, [valid]);
});

test("legacy payment rows without a campaign id are never attributed", () => {
  const parsed = parsePaymentRecords(
    JSON.stringify({ claimId: "7", publisher, amount: "100000", ref: "old", elapsedMs: 1, settleTx: tx }),
    campaign,
  );
  assert.deepEqual(parsed, []);
});

test("duplicate attempts require a campaign-bound reverted transaction capsule", () => {
  const valid = {
    type: "duplicate",
    campaignId: campaign,
    publisher,
    nullifier,
    evidenceHash,
    txHash: tx,
    status: "reverted",
    conversionId: "c-1",
  };
  const parsed = parseDuplicateAttempts(
    [
      JSON.stringify({ ...valid, status: "success" }),
      JSON.stringify({ ...valid, campaignId: otherCampaign }),
      JSON.stringify(valid),
    ].join("\n"),
    campaign,
  );
  assert.deepEqual(parsed, [
    { campaignId: campaign, publisher, nullifier, evidenceHash, txHash: tx, status: "reverted", conversionId: "c-1" },
  ]);
});

test("run metadata provides a campaign-bound scan start", () => {
  assert.deepEqual(
    parseRunMetadata(
      JSON.stringify({ campaignId: campaign, campaignName: "poc-demo-5", startBlock: "53280333" }),
      campaign,
    ),
    { campaignId: campaign, campaignName: "poc-demo-5", startBlock: 53280333n },
  );
  assert.equal(
    parseRunMetadata(
      JSON.stringify({ campaignId: otherCampaign, campaignName: "poc-demo-5", startBlock: "53280333" }),
      campaign,
    ),
    null,
  );
  assert.equal(
    parseRunMetadata(
      JSON.stringify({ campaignId: campaign, campaignName: "poc-demo-5", startBlock: "-1" }),
      campaign,
    ),
    null,
  );
});
