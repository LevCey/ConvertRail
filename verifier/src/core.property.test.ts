// Property-based tests for the verifier decision core (R6.2). No external
// generator dependency: a seeded mulberry32 PRNG drives thousands of varied
// inputs, and each test asserts an invariant that must hold across all of
// them. Seeds are fixed, so a failure reproduces exactly.
import { doesNotThrow, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import {
  evidenceHash,
  nullifier,
  type SignedConversionEvent,
  type VerificationPolicy,
} from "@convertrail/shared";
import { decide, type ClaimInput, type FundingLink } from "./core.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ITERATIONS = 2_000;

interface Sample {
  claim: ClaimInput;
  event: SignedConversionEvent;
  binding: Record<string, Address>;
  policy: VerificationPolicy;
  prior: number[];
}

// Builds a fully-clean sample (every rule passes), then callers perturb one
// dimension to isolate the rule under test.
function cleanSample(rand: () => number): Sample {
  const campaignId = randHex(rand, 32) as Hex;
  const publisherId = `pub-${Math.floor(rand() * 5)}`;
  const publisher = randHex(rand, 20) as Address;
  const conversionId = `c-${Math.floor(rand() * 1e9)}`;

  const policy: VerificationPolicy = {
    minClickToConversionMs: 500 + Math.floor(rand() * 3000),
    maxClaimsPerWindow: 1 + Math.floor(rand() * 20),
    rateWindowMs: 60_000,
    maxFundingLinkHops: Math.floor(rand() * 3), // 0, 1 or 2
    fundingHubMinDegree: 2 + Math.floor(rand() * 5),
  };

  const clickTs = Math.floor(rand() * 1e12);
  const conversionTs = clickTs + policy.minClickToConversionMs + Math.floor(rand() * 5000);
  const event: SignedConversionEvent = {
    campaignId,
    conversionId,
    publisherId,
    clickTs,
    conversionTs,
    signature: `0x${"ab".repeat(65)}`,
  };

  const claim: ClaimInput = {
    campaignId,
    publisher,
    nullifier: nullifier(campaignId, conversionId),
    evidenceHash: evidenceHash(event),
  };

  const prior = Array.from({ length: policy.maxClaimsPerWindow - 1 }, (_, i) => i);
  return { claim, event, binding: { [publisherId]: publisher }, policy, prior };
}

function randHex(rand: () => number, bytes: number): string {
  let out = "0x";
  for (let i = 0; i < bytes * 2; i++) out += Math.floor(rand() * 16).toString(16);
  return out;
}

function randLink(rand: () => number, hops: number): FundingLink {
  return {
    counterparty: randHex(rand, 20) as Address,
    hops,
    ...(hops === 2 ? { via: randHex(rand, 20) as Address } : {}),
  };
}

test("property: a fully-clean claim is always approved", () => {
  const rand = mulberry32(1);
  for (let i = 0; i < ITERATIONS; i++) {
    const s = cleanSample(rand);
    strictEqual(decide(s.claim, s.event, s.binding, s.policy, s.prior, null).approved, true, `iter ${i}`);
  }
});

test("property: decide is total — never throws on structured input", () => {
  const rand = mulberry32(2);
  doesNotThrow(() => {
    for (let i = 0; i < ITERATIONS; i++) {
      const s = cleanSample(rand);
      // randomly corrupt fields to exercise every branch
      const event = rand() < 0.5 ? null : s.event;
      const link = rand() < 0.5 ? null : randLink(rand, 1 + Math.floor(rand() * 3));
      decide(s.claim, event, s.binding, s.policy, s.prior, link);
    }
  });
});

test("property: a fabricated claim (no matching event) is always EVIDENCE_MISMATCH", () => {
  const rand = mulberry32(3);
  for (let i = 0; i < ITERATIONS; i++) {
    const s = cleanSample(rand);
    // Evidence outranks identity: a funding link present or absent must not
    // change which defect is reported.
    const link = rand() < 0.5 ? null : randLink(rand, 1);
    const verdict = decide(s.claim, null, s.binding, s.policy, s.prior, link);
    strictEqual(verdict.approved, false);
    if (!verdict.approved) strictEqual(verdict.reason, "EVIDENCE_MISMATCH", `iter ${i}`);
  }
});

test("property: conversion-before-click is always MALFORMED_EVIDENCE", () => {
  const rand = mulberry32(4);
  for (let i = 0; i < ITERATIONS; i++) {
    const base = cleanSample(rand);
    // swap so conversionTs < clickTs; evidence hash still matches this event,
    // nullifier + binding still valid, so the malformed check is what fires.
    const event = { ...base.event, clickTs: base.event.conversionTs, conversionTs: base.event.clickTs };
    const claim = { ...base.claim, evidenceHash: evidenceHash(event) };
    const verdict = decide(claim, event, base.binding, base.policy, base.prior, null);
    strictEqual(verdict.approved, false);
    if (!verdict.approved) strictEqual(verdict.reason, "MALFORMED_EVIDENCE", `iter ${i}`);
  }
});

test("property: at/over the rate cap (clean otherwise) is always RATE_ANOMALY", () => {
  const rand = mulberry32(5);
  for (let i = 0; i < ITERATIONS; i++) {
    const s = cleanSample(rand);
    const prior = Array.from({ length: s.policy.maxClaimsPerWindow + Math.floor(rand() * 5) }, (_, k) => k);
    const verdict = decide(s.claim, s.event, s.binding, s.policy, prior, null);
    strictEqual(verdict.approved, false);
    if (!verdict.approved) strictEqual(verdict.reason, "RATE_ANOMALY", `iter ${i}`);
  }
});

test("property: a link within policy hops is always LINKED_PUBLISHER", () => {
  const rand = mulberry32(7);
  for (let i = 0; i < ITERATIONS; i++) {
    const s = cleanSample(rand);
    // Force a policy that refuses links, then link at or inside its threshold.
    const policy = { ...s.policy, maxFundingLinkHops: 1 + Math.floor(rand() * 2) };
    const hops = 1 + Math.floor(rand() * policy.maxFundingLinkHops);
    const verdict = decide(s.claim, s.event, s.binding, policy, s.prior, randLink(rand, hops));
    strictEqual(verdict.approved, false);
    if (!verdict.approved) strictEqual(verdict.reason, "LINKED_PUBLISHER", `iter ${i}`);
  }
});

test("property: a link beyond policy hops never changes the verdict", () => {
  const rand = mulberry32(8);
  for (let i = 0; i < ITERATIONS; i++) {
    const s = cleanSample(rand);
    const distant = randLink(rand, s.policy.maxFundingLinkHops + 1 + Math.floor(rand() * 3));
    strictEqual(
      JSON.stringify(decide(s.claim, s.event, s.binding, s.policy, s.prior, distant)),
      JSON.stringify(decide(s.claim, s.event, s.binding, s.policy, s.prior, null)),
      `iter ${i}`,
    );
  }
});

test("property: determinism — identical inputs yield identical verdicts", () => {
  const rand = mulberry32(6);
  for (let i = 0; i < ITERATIONS; i++) {
    const s = cleanSample(rand);
    const event = rand() < 0.5 ? null : s.event;
    const link = rand() < 0.5 ? null : randLink(rand, 1 + Math.floor(rand() * 2));
    const a = decide(s.claim, event, s.binding, s.policy, s.prior, link);
    const b = decide(s.claim, event, s.binding, s.policy, s.prior, link);
    strictEqual(JSON.stringify(a), JSON.stringify(b), `iter ${i}`);
  }
});
