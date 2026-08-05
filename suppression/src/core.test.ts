import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decideNext, deriveStatus, emptyState, withinSla } from "./core.ts";
import { PlatformSubject } from "./types.ts";
import type { LifecycleState, SuppressionEnvelope, SuppressionPolicy, VerifiedClaim } from "./types.ts";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");

const claim: VerifiedClaim = {
  campaignId: `0x${"ab".repeat(32)}`,
  claimId: "7",
  evidenceHash: `0x${"cd".repeat(32)}`,
  verifiedAtBlock: "55149673",
};

function envelope(overrides: Partial<SuppressionEnvelope> = {}): SuppressionEnvelope {
  return {
    version: "convertrail.suppression.envelope/1",
    evidenceHash: claim.evidenceHash,
    subjectRef: "subj_synthetic_7",
    subject: new PlatformSubject({ em: "a".repeat(64) }),
    occurredAt: "2026-08-04T11:58:00.000Z",
    order: { value: "49.99", currency: "USD" },
    consent: { granted: true, purpose: "suppression", recordedAt: "2026-08-01T00:00:00.000Z" },
    expiresAt: "2026-08-04T12:05:00.000Z",
    merchantSignature: `0x${"11".repeat(65)}`,
    ...overrides,
  };
}

function policy(overrides: Partial<SuppressionPolicy> = {}): SuppressionPolicy {
  return {
    platform: "mock",
    trigger: "VERIFIED",
    enabled: true,
    dryRun: false,
    maxAttempts: 5,
    slaSeconds: 300,
    ...overrides,
  };
}

function stateWith(...reached: LifecycleState[]) {
  const s = emptyState();
  for (const r of reached) s.reached.add(r);
  return s;
}

test("a disabled policy skips before anything is fetched", () => {
  const action = decideNext(claim, null, emptyState(), policy({ enabled: false }), NOW);
  assert.deepEqual(action, { kind: "skip", reason: "SUPPRESSION_DISABLED" });
});

test("the first step is fetching the envelope", () => {
  assert.deepEqual(decideNext(claim, null, emptyState(), policy(), NOW), { kind: "fetch-envelope" });
});

test("a fetched envelope that is missing is fetched again", () => {
  const action = decideNext(claim, null, stateWith("ENVELOPE_FETCHED"), policy(), NOW);
  assert.deepEqual(action, { kind: "fetch-envelope" });
});

test("an envelope bound to a different claim aborts rather than proceeding", () => {
  const wrong = envelope({ evidenceHash: `0x${"ef".repeat(32)}` });
  const action = decideNext(claim, wrong, stateWith("ENVELOPE_FETCHED"), policy(), NOW);
  assert.deepEqual(action, { kind: "abort", code: "EVIDENCE_HASH_MISMATCH" });
});

test("evidence hash comparison ignores hex case", () => {
  const upper = envelope({ evidenceHash: claim.evidenceHash.toUpperCase() as `0x${string}` });
  const action = decideNext(claim, upper, stateWith("ENVELOPE_FETCHED"), policy(), NOW);
  assert.deepEqual(action, { kind: "dispatch-conversion" });
});

test("withheld consent skips, and skipping is not a failure", () => {
  const withheld = envelope({
    consent: { granted: false, purpose: "suppression", recordedAt: "2026-08-01T00:00:00.000Z" },
  });
  const action = decideNext(claim, withheld, stateWith("ENVELOPE_FETCHED"), policy(), NOW);
  assert.deepEqual(action, { kind: "skip", reason: "NO_CONSENT" });
});

test("an expired envelope aborts", () => {
  const stale = envelope({ expiresAt: "2026-08-04T11:59:59.999Z" });
  const action = decideNext(claim, stale, stateWith("ENVELOPE_FETCHED"), policy(), NOW);
  assert.deepEqual(action, { kind: "abort", code: "ENVELOPE_EXPIRED" });
});

test("expiry is exclusive at the boundary instant", () => {
  const exact = envelope({ expiresAt: new Date(NOW).toISOString() });
  const action = decideNext(claim, exact, stateWith("ENVELOPE_FETCHED"), policy(), NOW);
  assert.deepEqual(action, { kind: "abort", code: "ENVELOPE_EXPIRED" });
});

test("the happy path runs conversion, audience, exclusion, then receipt", () => {
  const env = envelope();
  const p = policy();
  const reached: LifecycleState[] = ["ENVELOPE_FETCHED"];
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    const action = decideNext(claim, env, stateWith(...reached), p, NOW);
    seen.push(action.kind);
    if (action.kind === "dispatch-conversion") reached.push("CONVERSION_ACCEPTED");
    else if (action.kind === "add-to-audience") reached.push("AUDIENCE_ACCEPTED");
    else if (action.kind === "verify-exclusion") reached.push("EXCLUSION_VERIFIED");
  }
  assert.deepEqual(seen, [
    "dispatch-conversion",
    "add-to-audience",
    "verify-exclusion",
    "sign-receipt",
  ]);
});

test("a signed receipt is terminal", () => {
  const action = decideNext(claim, envelope(), stateWith("RECEIPT_SIGNED"), policy(), NOW);
  assert.deepEqual(action, { kind: "done" });
});

test("a permanent failure produces a receipt instead of another attempt", () => {
  const state = stateWith("ENVELOPE_FETCHED", "CONVERSION_ACCEPTED");
  state.lastFailure = { permanent: true, code: "MOCK_INVALID" };
  assert.deepEqual(decideNext(claim, envelope(), state, policy(), NOW), {
    kind: "abort",
    code: "ATTEMPTS_EXHAUSTED",
  });

  state.reached.add("FAILED_PERMANENT");
  assert.deepEqual(decideNext(claim, envelope(), state, policy(), NOW), {
    kind: "sign-receipt",
    status: "PARTIAL",
  });
});

test("exhausted attempts abort", () => {
  const state = stateWith("ENVELOPE_FETCHED");
  state.attempts = 5;
  assert.deepEqual(decideNext(claim, envelope(), state, policy({ maxAttempts: 5 }), NOW), {
    kind: "abort",
    code: "ATTEMPTS_EXHAUSTED",
  });
});

test("status separates a conversion-only outcome from a total failure", () => {
  assert.equal(deriveStatus(stateWith("CONVERSION_ACCEPTED", "AUDIENCE_ACCEPTED", "EXCLUSION_VERIFIED")), "COMPLETED");
  assert.equal(deriveStatus(stateWith("CONVERSION_ACCEPTED", "AUDIENCE_ACCEPTED")), "PARTIAL");
  assert.equal(deriveStatus(stateWith("CONVERSION_ACCEPTED")), "PARTIAL");
  assert.equal(deriveStatus(stateWith("ENVELOPE_FETCHED")), "FAILED");
  const skipped = stateWith("SKIPPED");
  skipped.skipReason = "NO_CONSENT";
  assert.equal(deriveStatus(skipped), "SKIPPED");
});

test("an audience write without an accepted conversion is still PARTIAL, not COMPLETED", () => {
  assert.equal(deriveStatus(stateWith("AUDIENCE_ACCEPTED")), "PARTIAL");
});

test("the SLA spans observation to acceptance, and an unaccepted request never meets it", () => {
  const p = policy({ slaSeconds: 300 });
  assert.equal(withinSla(NOW, NOW + 300_000, p), true);
  assert.equal(withinSla(NOW, NOW + 300_001, p), false);
  assert.equal(withinSla(NOW, null, p), false);
});

test("the core carries no platform knowledge", () => {
  const source = readFileSync(new URL("./core.ts", import.meta.url), "utf8");
  for (const forbidden of ["adapters/", "fetch(", "Date.now(", "process.env"]) {
    assert.equal(source.includes(forbidden), false, `core.ts must not reference ${forbidden}`);
  }
});

/**
 * Recovery ordering. The decision is which operation remains, and only then
 * whether that operation needs buyer identity — never the other way round.
 */

test("only the steps that send a buyer require an envelope", () => {
  const p = policy();
  // Conversion outstanding: identity needed.
  assert.deepEqual(decideNext(claim, null, stateWith("ENVELOPE_FETCHED"), p, NOW), {
    kind: "fetch-envelope",
  });
  // Audience outstanding: identity needed.
  assert.deepEqual(
    decideNext(claim, null, stateWith("ENVELOPE_FETCHED", "CONVERSION_ACCEPTED"), p, NOW),
    { kind: "fetch-envelope" },
  );
  // Only the exclusion check left: it reads the advertiser's own configuration,
  // so a missing envelope is irrelevant.
  assert.deepEqual(
    decideNext(
      claim,
      null,
      stateWith("ENVELOPE_FETCHED", "CONVERSION_ACCEPTED", "AUDIENCE_ACCEPTED"),
      p,
      NOW,
    ),
    { kind: "verify-exclusion" },
  );
});

test("once the exclusion step is closed, only signing remains", () => {
  const done = stateWith(
    "ENVELOPE_FETCHED",
    "CONVERSION_ACCEPTED",
    "AUDIENCE_ACCEPTED",
    "EXCLUSION_VERIFIED",
  );
  assert.deepEqual(decideNext(claim, null, done, policy(), NOW), {
    kind: "sign-receipt",
    status: "COMPLETED",
  });

  const unverified = stateWith(
    "ENVELOPE_FETCHED",
    "CONVERSION_ACCEPTED",
    "AUDIENCE_ACCEPTED",
    "EXCLUSION_UNVERIFIED",
  );
  assert.deepEqual(decideNext(claim, null, unverified, policy(), NOW), {
    kind: "sign-receipt",
    status: "PARTIAL",
  });
});

test("an expired or misbound envelope still stops the steps that need one", () => {
  const beforeConversion = stateWith("ENVELOPE_FETCHED");
  assert.deepEqual(
    decideNext(claim, envelope({ expiresAt: "2026-08-04T11:00:00.000Z" }), beforeConversion, policy(), NOW),
    { kind: "abort", code: "ENVELOPE_EXPIRED" },
  );
  assert.deepEqual(
    decideNext(
      claim,
      envelope({ evidenceHash: `0x${"ef".repeat(32)}` }),
      beforeConversion,
      policy(),
      NOW,
    ),
    { kind: "abort", code: "EVIDENCE_HASH_MISMATCH" },
  );
});

test("an expired envelope does not block a step that never needed it", () => {
  // The check reads no buyer, so an envelope that has aged out is beside the
  // point rather than a reason to fail.
  const afterAudience = stateWith("ENVELOPE_FETCHED", "CONVERSION_ACCEPTED", "AUDIENCE_ACCEPTED");
  assert.deepEqual(
    decideNext(claim, envelope({ expiresAt: "2026-08-04T11:00:00.000Z" }), afterAudience, policy(), NOW),
    { kind: "verify-exclusion" },
  );
});
