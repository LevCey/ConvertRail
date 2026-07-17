import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import {
  reconstructFraudLog,
  type RejectedEventArgs,
  type SubmittedEventArgs,
} from "./fraudlog.ts";
import { REJECT_REASON } from "./contracts.ts";

const CAMPAIGN = `0x${"11".repeat(32)}` as Hex;
const PUB_A = "0x00000000000000000000000000000000000000aa" as Address;
const FRAUD = "0x00000000000000000000000000000000000000cc" as Address;

function submitted(claimId: bigint, publisher: Address, seed: string): SubmittedEventArgs {
  return {
    claimId,
    campaignId: CAMPAIGN,
    publisher,
    nullifier: `0x${seed.repeat(64).slice(0, 64)}` as Hex,
    evidenceHash: `0x${seed.repeat(64).slice(0, 64)}` as Hex,
  };
}

function rejected(claimId: bigint, publisher: Address, reason: number): RejectedEventArgs {
  return { claimId, campaignId: CAMPAIGN, publisher, reason };
}

test("rebuilds the fraud log purely from chain events (R5.4)", () => {
  // Claims 1 & 3 are clean (verified, no rejection); 2 & 4 are fraud.
  const subs = [
    submitted(1n, PUB_A, "a"),
    submitted(2n, FRAUD, "b"),
    submitted(3n, PUB_A, "c"),
    submitted(4n, FRAUD, "d"),
  ];
  const rejs = [
    rejected(2n, FRAUD, REJECT_REASON.EVIDENCE_MISMATCH),
    rejected(4n, FRAUD, REJECT_REASON.TIMING_ANOMALY),
  ];

  const log = reconstructFraudLog(subs, rejs);
  deepStrictEqual(log, [
    {
      claimId: 2n,
      campaignId: CAMPAIGN,
      publisher: FRAUD,
      nullifier: subs[1].nullifier,
      evidenceHash: subs[1].evidenceHash,
      reason: "EVIDENCE_MISMATCH",
    },
    {
      claimId: 4n,
      campaignId: CAMPAIGN,
      publisher: FRAUD,
      nullifier: subs[3].nullifier,
      evidenceHash: subs[3].evidenceHash,
      reason: "TIMING_ANOMALY",
    },
  ]);
});

test("excludes verified claims — only rejected verdicts enter the log", () => {
  const subs = [submitted(1n, PUB_A, "a"), submitted(2n, FRAUD, "b")];
  const log = reconstructFraudLog(subs, []); // no rejections at all
  strictEqual(log.length, 0);
});

test("preserves the evidence capsule and maps every reason code", () => {
  const subs = [
    submitted(1n, FRAUD, "1"),
    submitted(2n, FRAUD, "2"),
    submitted(3n, FRAUD, "3"),
  ];
  const rejs = [
    rejected(1n, FRAUD, REJECT_REASON.RATE_ANOMALY),
    rejected(2n, FRAUD, REJECT_REASON.MALFORMED_EVIDENCE),
    rejected(3n, FRAUD, REJECT_REASON.EVIDENCE_MISMATCH),
  ];
  const log = reconstructFraudLog(subs, rejs);
  deepStrictEqual(
    log.map((e) => e.reason),
    ["RATE_ANOMALY", "MALFORMED_EVIDENCE", "EVIDENCE_MISMATCH"],
  );
  // capsule carried through verbatim from the submit event
  strictEqual(log[0].nullifier, subs[0].nullifier);
  strictEqual(log[0].evidenceHash, subs[0].evidenceHash);
});

test("orders by claimId regardless of event arrival order", () => {
  const subs = [submitted(5n, FRAUD, "5"), submitted(2n, FRAUD, "2"), submitted(9n, FRAUD, "9")];
  const rejs = [
    rejected(9n, FRAUD, REJECT_REASON.EVIDENCE_MISMATCH),
    rejected(2n, FRAUD, REJECT_REASON.EVIDENCE_MISMATCH),
    rejected(5n, FRAUD, REJECT_REASON.EVIDENCE_MISMATCH),
  ];
  strictEqual(
    reconstructFraudLog(subs, rejs)
      .map((e) => e.claimId)
      .join(","),
    "2,5,9",
  );
});

test("never fabricates: a rejection with no matching submit is skipped", () => {
  const log = reconstructFraudLog([submitted(1n, FRAUD, "1")], [
    rejected(1n, FRAUD, REJECT_REASON.EVIDENCE_MISMATCH),
    rejected(7n, FRAUD, REJECT_REASON.EVIDENCE_MISMATCH), // no submit for 7
  ]);
  strictEqual(log.length, 1);
  strictEqual(log[0].claimId, 1n);
});

test("determinism: replaying the same events reproduces the same log", () => {
  const subs = [submitted(1n, PUB_A, "a"), submitted(2n, FRAUD, "b"), submitted(3n, FRAUD, "c")];
  const rejs = [
    rejected(3n, FRAUD, REJECT_REASON.TIMING_ANOMALY),
    rejected(2n, FRAUD, REJECT_REASON.EVIDENCE_MISMATCH),
  ];
  const first = reconstructFraudLog(subs, rejs);
  for (let i = 0; i < 50; i++) {
    deepStrictEqual(reconstructFraudLog(subs, rejs), first);
  }
});
