import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import {
  evidenceHash,
  nullifier,
  type SignedConversionEvent,
  type VerificationPolicy,
} from "@proof-of-conversion/shared";
import { decide, type ClaimInput } from "./core.ts";

const CAMPAIGN = `0x${"11".repeat(32)}` as const;
const PUB_A = "0x00000000000000000000000000000000000000Aa" as Address;
const PUB_X = "0x00000000000000000000000000000000000000bb" as Address;

const binding = { "pub-a": PUB_A };

const policy: VerificationPolicy = {
  minClickToConversionMs: 1500,
  maxClaimsPerWindow: 5,
  rateWindowMs: 60_000,
};

function makeEvent(overrides: Partial<SignedConversionEvent> = {}): SignedConversionEvent {
  return {
    campaignId: CAMPAIGN,
    conversionId: "c-1",
    publisherId: "pub-a",
    clickTs: 10_000,
    conversionTs: 15_000,
    signature: `0x${"ab".repeat(65)}`,
    ...overrides,
  };
}

function makeClaim(event: SignedConversionEvent, overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    campaignId: event.campaignId,
    publisher: binding[event.publisherId as "pub-a"] ?? PUB_A,
    nullifier: nullifier(event.campaignId, event.conversionId),
    evidenceHash: evidenceHash(event),
    ...overrides,
  };
}

test("approves a clean claim", () => {
  const event = makeEvent();
  deepStrictEqual(decide(makeClaim(event), event, binding, policy, []), { approved: true });
});

test("rejects when no event matches the evidence hash (fabricated claim)", () => {
  const event = makeEvent();
  deepStrictEqual(decide(makeClaim(event), null, binding, policy, []), {
    approved: false,
    reason: "EVIDENCE_MISMATCH",
  });
});

test("rejects a stolen conversion: fresh nullifier over someone else's evidence", () => {
  const event = makeEvent();
  const claim = makeClaim(event, {
    nullifier: nullifier(CAMPAIGN, "c-other"),
  });
  deepStrictEqual(decide(claim, event, binding, policy, []), {
    approved: false,
    reason: "EVIDENCE_MISMATCH",
  });
});

test("rejects when the claimant is not the event's bound publisher", () => {
  const event = makeEvent();
  const claim = makeClaim(event, { publisher: PUB_X });
  deepStrictEqual(decide(claim, event, binding, policy, []), {
    approved: false,
    reason: "EVIDENCE_MISMATCH",
  });
});

test("rejects campaign mismatch", () => {
  const event = makeEvent();
  const other = makeEvent({ campaignId: `0x${"22".repeat(32)}` });
  const claim = makeClaim(other);
  deepStrictEqual(decide(claim, event, binding, policy, []), {
    approved: false,
    reason: "EVIDENCE_MISMATCH",
  });
});

test("rejects malformed evidence: conversion before click", () => {
  const event = makeEvent({ clickTs: 20_000, conversionTs: 15_000 });
  deepStrictEqual(decide(makeClaim(event), event, binding, policy, []), {
    approved: false,
    reason: "MALFORMED_EVIDENCE",
  });
});

test("rejects impossible instant conversions", () => {
  const event = makeEvent({ clickTs: 14_000, conversionTs: 15_000 }); // 1000ms < 1500ms floor
  deepStrictEqual(decide(makeClaim(event), event, binding, policy, []), {
    approved: false,
    reason: "TIMING_ANOMALY",
  });
});

test("rejects burst floods over the rate window", () => {
  const event = makeEvent();
  const prior = [1, 2, 3, 4, 5]; // already at maxClaimsPerWindow
  deepStrictEqual(decide(makeClaim(event), event, binding, policy, prior), {
    approved: false,
    reason: "RATE_ANOMALY",
  });
});

test("determinism: replaying identical inputs yields identical verdicts", () => {
  const event = makeEvent();
  const claim = makeClaim(event);
  const first = decide(claim, event, binding, policy, [1, 2]);
  for (let i = 0; i < 100; i++) {
    deepStrictEqual(decide(claim, event, binding, policy, [1, 2]), first);
  }
});
