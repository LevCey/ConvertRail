import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import {
  evidenceHash,
  nullifier,
  type SignedConversionEvent,
  type VerificationPolicy,
} from "@convertrail/shared";
import { decide, type ClaimInput, type FundingLink } from "./core.ts";

const CAMPAIGN = `0x${"11".repeat(32)}` as const;
const PUB_A = "0x00000000000000000000000000000000000000Aa" as Address;
const PUB_X = "0x00000000000000000000000000000000000000bb" as Address;
const PUB_Y = "0x00000000000000000000000000000000000000cc" as Address;
const FAUCET = "0x00000000000000000000000000000000000000dd" as Address;

const binding = { "pub-a": PUB_A };

const policy: VerificationPolicy = {
  minClickToConversionMs: 1500,
  maxClaimsPerWindow: 5,
  rateWindowMs: 60_000,
  maxFundingLinkHops: 2,
  fundingHubMinDegree: 3,
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
  deepStrictEqual(decide(makeClaim(event), event, binding, policy, [], null), { approved: true });
});

test("rejects when no event matches the evidence hash (fabricated claim)", () => {
  const event = makeEvent();
  deepStrictEqual(decide(makeClaim(event), null, binding, policy, [], null), {
    approved: false,
    reason: "EVIDENCE_MISMATCH",
  });
});

test("rejects a stolen conversion: fresh nullifier over someone else's evidence", () => {
  const event = makeEvent();
  const claim = makeClaim(event, {
    nullifier: nullifier(CAMPAIGN, "c-other"),
  });
  deepStrictEqual(decide(claim, event, binding, policy, [], null), {
    approved: false,
    reason: "EVIDENCE_MISMATCH",
  });
});

test("rejects when the claimant is not the event's bound publisher", () => {
  const event = makeEvent();
  const claim = makeClaim(event, { publisher: PUB_X });
  deepStrictEqual(decide(claim, event, binding, policy, [], null), {
    approved: false,
    reason: "EVIDENCE_MISMATCH",
  });
});

test("rejects campaign mismatch", () => {
  const event = makeEvent();
  const other = makeEvent({ campaignId: `0x${"22".repeat(32)}` });
  const claim = makeClaim(other);
  deepStrictEqual(decide(claim, event, binding, policy, [], null), {
    approved: false,
    reason: "EVIDENCE_MISMATCH",
  });
});

test("rejects malformed evidence: conversion before click", () => {
  const event = makeEvent({ clickTs: 20_000, conversionTs: 15_000 });
  deepStrictEqual(decide(makeClaim(event), event, binding, policy, [], null), {
    approved: false,
    reason: "MALFORMED_EVIDENCE",
  });
});

test("rejects impossible instant conversions", () => {
  const event = makeEvent({ clickTs: 14_000, conversionTs: 15_000 }); // 1000ms < 1500ms floor
  deepStrictEqual(decide(makeClaim(event), event, binding, policy, [], null), {
    approved: false,
    reason: "TIMING_ANOMALY",
  });
});

test("rejects burst floods over the rate window", () => {
  const event = makeEvent();
  const prior = [1, 2, 3, 4, 5]; // already at maxClaimsPerWindow
  deepStrictEqual(decide(makeClaim(event), event, binding, policy, prior, null), {
    approved: false,
    reason: "RATE_ANOMALY",
  });
});

test("rejects bot traffic: the fraud publisher's own event, converting too fast", () => {
  // The demo's third attack class. Evidence is a genuine signed merchant event
  // bound to the claimant, so hash and binding both pass — timing is the only
  // rule standing between synthetic traffic and a payout.
  const event = makeEvent({ publisherId: "pub-x", clickTs: 14_700, conversionTs: 15_000 });
  const claim: ClaimInput = {
    campaignId: CAMPAIGN,
    publisher: PUB_X,
    nullifier: nullifier(CAMPAIGN, event.conversionId),
    evidenceHash: evidenceHash(event),
  };
  deepStrictEqual(decide(claim, event, { ...binding, "pub-x": PUB_X }, policy, [], null), {
    approved: false,
    reason: "TIMING_ANOMALY",
  });
});

// --- Identity integrity: the fourth attack class -------------------------

/** A second publisher identity whose evidence and timing are entirely genuine —
 * the only defect is who funded it. */
function sybilClaim(): { claim: ClaimInput; event: SignedConversionEvent; binding: Record<string, Address> } {
  const event = makeEvent({ publisherId: "pub-y", conversionId: "c-sybil" });
  return {
    event,
    claim: {
      campaignId: CAMPAIGN,
      publisher: PUB_Y,
      nullifier: nullifier(CAMPAIGN, event.conversionId),
      evidenceHash: evidenceHash(event),
    },
    binding: { ...binding, "pub-y": PUB_Y },
  };
}

test("rejects a claimant funded directly by another participant", () => {
  const s = sybilClaim();
  const link: FundingLink = { counterparty: PUB_X, hops: 1 };
  deepStrictEqual(decide(s.claim, s.event, s.binding, policy, [], link), {
    approved: false,
    reason: "LINKED_PUBLISHER",
  });
});

test("rejects a claimant sharing a funder with another participant", () => {
  const s = sybilClaim();
  const link: FundingLink = { counterparty: PUB_X, hops: 2, via: FAUCET };
  deepStrictEqual(decide(s.claim, s.event, s.binding, policy, [], link), {
    approved: false,
    reason: "LINKED_PUBLISHER",
  });
});

test("a shared funder is tolerated when policy refuses direct funding only", () => {
  const s = sybilClaim();
  const link: FundingLink = { counterparty: PUB_X, hops: 2, via: FAUCET };
  const direct: VerificationPolicy = { ...policy, maxFundingLinkHops: 1 };
  deepStrictEqual(decide(s.claim, s.event, s.binding, direct, [], link), { approved: true });
});

test("maxFundingLinkHops of 0 disables the check entirely", () => {
  const s = sybilClaim();
  const link: FundingLink = { counterparty: PUB_X, hops: 1 };
  const off: VerificationPolicy = { ...policy, maxFundingLinkHops: 0 };
  deepStrictEqual(decide(s.claim, s.event, s.binding, off, [], link), { approved: true });
});

test("a funding link never masks an evidence defect", () => {
  // Ordering guarantee: a fabricated claim from a linked identity must still be
  // reported as the evidence failure it is. Reason codes are the public record
  // of why a payout was refused; the most specific defect has to win.
  const s = sybilClaim();
  const link: FundingLink = { counterparty: PUB_X, hops: 1 };
  deepStrictEqual(decide(s.claim, null, s.binding, policy, [], link), {
    approved: false,
    reason: "EVIDENCE_MISMATCH",
  });
});

test("a funding link outranks timing and rate anomalies", () => {
  // Ordering guarantee in the other direction: who the claimant is outranks how
  // it behaved. A linked identity running bot traffic is one operator paying
  // itself, which is the finding worth recording.
  const event = makeEvent({ publisherId: "pub-y", conversionId: "c-sybil", clickTs: 14_700, conversionTs: 15_000 });
  const claim: ClaimInput = {
    campaignId: CAMPAIGN,
    publisher: PUB_Y,
    nullifier: nullifier(CAMPAIGN, event.conversionId),
    evidenceHash: evidenceHash(event),
  };
  const link: FundingLink = { counterparty: PUB_X, hops: 1 };
  deepStrictEqual(decide(claim, event, { ...binding, "pub-y": PUB_Y }, policy, [1, 2, 3, 4, 5], link), {
    approved: false,
    reason: "LINKED_PUBLISHER",
  });
});

test("determinism: replaying identical inputs yields identical verdicts", () => {
  const event = makeEvent();
  const claim = makeClaim(event);
  const link: FundingLink = { counterparty: PUB_X, hops: 2, via: FAUCET };
  const first = decide(claim, event, binding, policy, [1, 2], link);
  for (let i = 0; i < 100; i++) {
    deepStrictEqual(decide(claim, event, binding, policy, [1, 2], link), first);
  }
});
