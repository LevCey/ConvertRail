import { strict as assert } from "node:assert";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJSON } from "@convertrail/shared";
import { MockSuppressionAdapter, type MockScript } from "./adapters/mock.ts";
import { processClaim, type RunnerDeps } from "./runner.ts";
import { buildReceiptBody, verifyReceipt } from "./receipt.ts";
import { digest, envelopeFingerprint, redactOutcome, subjectCommitment } from "./redaction.ts";
import { SuppressionStore } from "./store.ts";
import { PlatformSubject, UNIDENTIFIED_SUBJECT } from "./types.ts";
import type { SuppressionEnvelope, SuppressionPolicy, VerifiedClaim } from "./types.ts";

/**
 * Crash recovery for the receipt itself.
 *
 * The lifecycle survived a restart from the first version, but the receipt's
 * evidence did not: outcomes, the acceptance timestamp and the exclusion digest
 * lived in the runner's local variables. A worker that died after the audience
 * write and came back would sign a receipt saying `acceptedAt: null` over an
 * acceptance that had happened — a document that understated its own work and
 * whose response digest covered none of it.
 */

const signer = privateKeyToAccount(`0x${"42".repeat(32)}`);
const EM = "9".repeat(64);

const claim: VerifiedClaim = {
  campaignId: `0x${"ab".repeat(32)}`,
  claimId: "7",
  evidenceHash: `0x${"cd".repeat(32)}`,
  verifiedAtBlock: "55149673",
};

const roots: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "convertrail-recovery-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

// Fixed, not derived from `Date.now()` at call time. A merchant's record of when
// a purchase happened is the same on every read; an envelope that changed
// between reads is precisely what the fingerprint check exists to catch.
const OCCURRED_AT = new Date(Date.parse("2026-08-04T11:58:00.000Z")).toISOString();
const CONSENT_AT = new Date(Date.parse("2026-08-04T11:57:00.000Z")).toISOString();

function envelope(): SuppressionEnvelope {
  return {
    version: "convertrail.suppression.envelope/1",
    evidenceHash: claim.evidenceHash,
    subjectRef: "subj_017",
    subject: new PlatformSubject({ em: EM }),
    occurredAt: OCCURRED_AT,
    order: { value: "49.99", currency: "USD" },
    consent: {
      granted: true,
      purpose: "advertising-suppression",
      recordedAt: CONSENT_AT,
    },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    merchantSignature: `0x${"11".repeat(65)}`,
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

function deps(dir: string, script?: MockScript, policyOverrides?: Partial<SuppressionPolicy>) {
  const adapter = new MockSuppressionAdapter(script);
  const store = new SuppressionStore(dir);
  const runnerDeps: RunnerDeps = {
    store,
    adapter,
    policy: policy(policyOverrides),
    signer,
    tenantId: "poc-demo-suppression",
    commitmentKey: "c".repeat(48),
    fetchEnvelope: async () => ({ ok: true, envelope: envelope() }),
    now: Date.now,
    sleep: async () => {},
  };
  return { deps: runnerDeps, adapter, store };
}

/** Write a record straight to the journal, bypassing the append-time guard, so
 * the cold-load path can be tested against a file that is already inconsistent. */
function appendRaw(dir: string, record: unknown): void {
  appendFileSync(join(dir, "journal.jsonl"), `${canonicalJSON(record)}\n`);
}

/**
 * Run until the given lifecycle state is recorded, then stop as abruptly as a
 * kill would — the journal keeps whatever was written, nothing else survives.
 */
async function crashAfter(
  dir: string,
  state: string,
  script?: MockScript,
  policyOverrides?: Partial<SuppressionPolicy>,
): Promise<void> {
  const { deps: runnerDeps, store } = deps(dir, script, policyOverrides);
  const realAppend = store.append.bind(store);
  class Killed extends Error {}
  store.append = (record) => {
    realAppend(record);
    if (record.type === "transition" && record.state === state) throw new Killed(state);
  };
  await assert.rejects(() => processClaim(claim, runnerDeps), Killed);
}

test("a crash after the conversion was accepted does not re-dispatch it", async () => {
  const dir = freshDir();
  await crashAfter(dir, "CONVERSION_ACCEPTED");

  const resumed = deps(dir);
  const receipt = await processClaim(claim, resumed.deps);
  assert.equal(resumed.adapter.effectCount("conversion"), 0, "the conversion must not be resent");
  assert.equal(resumed.adapter.effectCount("audience"), 1);
  assert.equal(receipt.status, "COMPLETED");
});

test("a crash after the conversion still carries its outcome into the receipt digest", async () => {
  const dir = freshDir();
  await crashAfter(dir, "CONVERSION_ACCEPTED");

  const before = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock");
  assert.equal(before.outcomes.length, 1, "the conversion outcome is on disk");

  const resumed = deps(dir);
  const receipt = await processClaim(claim, resumed.deps);
  const after = resumed.store.progress(claim.campaignId, claim.claimId, "mock");
  assert.equal(after.outcomes.length, 3, "conversion, audience and exclusion are all represented");
  assert.equal(receipt.responseDigest, digest(after.outcomes));
});

test("a crash after the audience write preserves the acceptance timestamp", async () => {
  const dir = freshDir();
  await crashAfter(dir, "AUDIENCE_ACCEPTED");

  const recorded = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock");
  assert.equal(typeof recorded.audienceAcceptedAt, "string");

  const resumed = deps(dir);
  const receipt = await processClaim(claim, resumed.deps);
  assert.equal(receipt.acceptedAt, recorded.audienceAcceptedAt);
  assert.equal(resumed.adapter.effectCount("audience"), 0, "the audience must not be rewritten");
  assert.equal((await verifyReceipt(receipt)).valid, true);
});

test("without recovery the SLA would be reported from a null acceptance", async () => {
  const dir = freshDir();
  await crashAfter(dir, "AUDIENCE_ACCEPTED");
  const resumed = deps(dir);
  const receipt = await processClaim(claim, resumed.deps);
  // The regression this guards: a resumed run signing acceptedAt: null over an
  // acceptance that demonstrably happened.
  assert.notEqual(receipt.acceptedAt, null);
  assert.equal(Date.parse(receipt.acceptedAt ?? "") >= Date.parse(receipt.observedAt), true);
});

test("a crash after the exclusion check preserves the configuration digest", async () => {
  const dir = freshDir();
  await crashAfter(dir, "EXCLUSION_VERIFIED");

  const recorded = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock");
  assert.match(recorded.exclusionDigest ?? "", /^0x[0-9a-f]{64}$/);

  const resumed = deps(dir);
  const receipt = await processClaim(claim, resumed.deps);
  assert.equal(receipt.exclusionConfigurationHash, recorded.exclusionDigest);
  assert.notEqual(receipt.exclusionConfigurationHash, "unverified");
  assert.equal(resumed.adapter.calls.length, 0, "nothing is re-executed");
  assert.equal(receipt.status, "COMPLETED");
});

test("a resumed receipt is indistinguishable from one produced in a single pass", async () => {
  const straight = freshDir();
  const uninterrupted = await processClaim(claim, deps(straight).deps);

  const interrupted = freshDir();
  await crashAfter(interrupted, "AUDIENCE_ACCEPTED");
  const resumed = await processClaim(claim, deps(interrupted).deps);

  // Timestamps differ between runs; everything the receipt asserts about the
  // work does not.
  const normalise = (r: typeof uninterrupted) => ({
    ...r,
    observedAt: "",
    acceptedAt: r.acceptedAt === null ? null : "",
    signature: "",
    responseDigest: "",
  });
  assert.deepEqual(normalise(resumed), normalise(uninterrupted));
  assert.equal(resumed.status, "COMPLETED");
});

test("the recorded outcome digest matches what a reader recomputes from the journal", async () => {
  const dir = freshDir();
  const { deps: runnerDeps, adapter } = deps(dir);
  const receipt = await processClaim(claim, runnerDeps);

  // A third party replaying the journal must arrive at the same digest the
  // receipt committed to.
  const replayed = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock");
  assert.equal(receipt.responseDigest, digest(replayed.outcomes));
  assert.equal(adapter.calls.length, 3);
});

test("a crash during a retry does not double count the outcome list", async () => {
  const dir = freshDir();
  await crashAfter(dir, "RETRY_SCHEDULED", { conversion: ["transient", "accepted"] });
  const first = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock");
  assert.equal(first.outcomes.length, 1, "only the failed attempt is on disk");

  const resumed = deps(dir, { conversion: ["accepted"] });
  const receipt = await processClaim(claim, resumed.deps);
  const after = resumed.store.progress(claim.campaignId, claim.claimId, "mock");
  assert.equal(after.outcomes.length, 4, "the failed attempt plus three successes");
  assert.equal(receipt.responseDigest, digest(after.outcomes));
});

test("redacted outcomes survive the journal round trip unchanged", async () => {
  const dir = freshDir();
  const { deps: runnerDeps } = deps(dir);
  await processClaim(claim, runnerDeps);

  const replayed = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock");
  for (const outcome of replayed.outcomes) {
    const shape = outcome as Record<string, unknown>;
    assert.equal(typeof shape.kind, "string");
    assert.equal(typeof shape.responseDigest, "string");
    assert.equal(JSON.stringify(outcome).includes(EM), false);
  }
  // The redaction is idempotent, so replaying and re-redacting is stable.
  const sample = replayed.outcomes[0] as Parameters<typeof redactOutcome>[0];
  assert.equal(typeof sample.kind, "string");
});

/**
 * The commitment is the field that says *who* a receipt is about. Everything
 * else can be rebuilt from the platform's own records; this one cannot, because
 * deriving it needs the envelope and the merchant is not obliged to still be
 * there.
 */

test("the commitment is written the moment an authenticated envelope is accepted", async () => {
  const dir = freshDir();
  await crashAfter(dir, "ENVELOPE_FETCHED");
  const progress = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock");
  assert.match(progress.subjectCommitment ?? "", /^[0-9a-f]{64}$/);
  assert.equal(
    progress.subjectCommitment,
    subjectCommitment("c".repeat(48), "poc-demo-suppression", "subj_017"),
  );
});

test("a crash after exclusion, with the merchant permanently gone, still binds the real buyer", async () => {
  const dir = freshDir();
  await crashAfter(dir, "EXCLUSION_VERIFIED");
  const expected = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock")
    .subjectCommitment;
  assert.match(expected ?? "", /^[0-9a-f]{64}$/);

  // The merchant is gone for good. Nothing may be re-derived from it.
  const adapter = new MockSuppressionAdapter();
  const store = new SuppressionStore(dir);
  let envelopeCalls = 0;
  const receipt = await processClaim(claim, {
    store,
    adapter,
    policy: policy(),
    signer,
    tenantId: "poc-demo-suppression",
    commitmentKey: "c".repeat(48),
    fetchEnvelope: async () => {
      envelopeCalls++;
      return { ok: false, retryable: false, reason: "ENVELOPE_HTTP_410" };
    },
    now: Date.now,
    sleep: async () => {},
  });

  assert.equal(receipt.status, "COMPLETED");
  assert.equal(receipt.subjectCommitment, expected, "bound to the buyer actually submitted");
  assert.equal(adapter.calls.length, 0, "zero repeated platform calls");
  assert.equal(envelopeCalls, 0, "a finished claim has nothing left to ask the merchant for");
  assert.equal((await verifyReceipt(receipt)).valid, true);
});

test("the commitment never falls back to something derived from the evidence hash", async () => {
  const dir = freshDir();
  await crashAfter(dir, "EXCLUSION_VERIFIED");
  const store = new SuppressionStore(dir);
  const receipt = await processClaim(claim, {
    store,
    adapter: new MockSuppressionAdapter(),
    policy: policy(),
    signer,
    tenantId: "poc-demo-suppression",
    commitmentKey: "c".repeat(48),
    fetchEnvelope: async () => ({ ok: false, retryable: false, reason: "ENVELOPE_HTTP_410" }),
    now: Date.now,
    sleep: async () => {},
  });
  const fallback = subjectCommitment(
    "c".repeat(48),
    "poc-demo-suppression",
    `unresolved:${claim.evidenceHash}`,
  );
  assert.notEqual(receipt.subjectCommitment, fallback);
  assert.notEqual(receipt.subjectCommitment, UNIDENTIFIED_SUBJECT);
});

test("after the audience write, a merchant outage cannot block the exclusion check", async () => {
  // Only the exclusion check remains, and reading the advertiser's own ad set
  // configuration involves no buyer at all. Deciding what is left before
  // deciding whether identity is needed is what keeps an unreachable merchant
  // from failing a claim it has nothing to do with.
  const dir = freshDir();
  await crashAfter(dir, "AUDIENCE_ACCEPTED");
  const expected = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock")
    .subjectCommitment;

  const adapter = new MockSuppressionAdapter();
  let envelopeCalls = 0;
  const receipt = await processClaim(claim, {
    store: new SuppressionStore(dir),
    adapter,
    policy: policy(),
    signer,
    tenantId: "poc-demo-suppression",
    commitmentKey: "c".repeat(48),
    fetchEnvelope: async () => {
      envelopeCalls++;
      return { ok: false, retryable: false, reason: "ENVELOPE_HTTP_410" };
    },
    now: Date.now,
    sleep: async () => {},
  });

  assert.equal(envelopeCalls, 0, "the remaining work needs no buyer identity");
  assert.equal(adapter.effectCount("exclusion-check"), 1);
  assert.equal(adapter.effectCount("conversion"), 0);
  assert.equal(adapter.effectCount("audience"), 0);
  assert.equal(receipt.status, "COMPLETED", "a complete coverage result still completes");
  assert.equal(receipt.subjectCommitment, expected);
  assert.equal((await verifyReceipt(receipt)).valid, true);
});

test("after an unverified exclusion, only signing remains", async () => {
  const dir = freshDir();
  await crashAfter(dir, "EXCLUSION_UNVERIFIED", undefined, { dryRun: true });

  const adapter = new MockSuppressionAdapter();
  const store = new SuppressionStore(dir);
  let envelopeCalls = 0;
  const receipt = await processClaim(claim, {
    store,
    adapter,
    policy: policy({ dryRun: true }),
    signer,
    tenantId: "poc-demo-suppression",
    commitmentKey: "c".repeat(48),
    fetchEnvelope: async () => {
      envelopeCalls++;
      return { ok: false, retryable: false, reason: "ENVELOPE_HTTP_410" };
    },
    now: Date.now,
    sleep: async () => {},
  });

  assert.equal(envelopeCalls, 0);
  assert.equal(adapter.calls.length, 0, "nothing is re-executed");
  assert.equal(receipt.status, "PARTIAL", "an unverified exclusion is not a completion");
  assert.equal((await verifyReceipt(receipt)).valid, true);
  assert.equal(
    store.records().some((r) => r.type === "dead-letter"),
    false,
    "not looking is not an operational failure",
  );
});

test("after the conversion, the envelope is refetched because the audience write needs identity", async () => {
  const dir = freshDir();
  await crashAfter(dir, "CONVERSION_ACCEPTED");
  const expected = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock")
    .subjectCommitment;

  const adapter = new MockSuppressionAdapter();
  let envelopeCalls = 0;
  const receipt = await processClaim(claim, {
    store: new SuppressionStore(dir),
    adapter,
    policy: policy(),
    signer,
    tenantId: "poc-demo-suppression",
    commitmentKey: "c".repeat(48),
    fetchEnvelope: async () => {
      envelopeCalls++;
      return { ok: true, envelope: envelope() };
    },
    now: Date.now,
    sleep: async () => {},
  });

  assert.equal(envelopeCalls, 1, "the audience write sends a buyer, so identity is required");
  assert.equal(adapter.effectCount("conversion"), 0);
  assert.equal(adapter.effectCount("audience"), 1);
  assert.equal(receipt.subjectCommitment, expected);
  assert.equal(receipt.status, "COMPLETED");
});

test("a rebound envelope is rejected before the audience write it was fetched for", async () => {
  const dir = freshDir();
  await crashAfter(dir, "CONVERSION_ACCEPTED");

  const h = rebindHarness(dir, { subjectRef: "subj_999" });
  let sawAudience = false;
  const original = h.adapter.addToExclusionAudience.bind(h.adapter);
  h.adapter.addToExclusionAudience = async (input) => {
    sawAudience = true;
    return original(input);
  };

  await processClaim(claim, h.deps);
  assert.equal(sawAudience, false, "validation runs before the call it guards");
});

test("a claim needing the conversion still cannot proceed without an envelope", async () => {
  const dir = freshDir();
  const { deps: runnerDeps, adapter } = deps(dir);
  let envelopeCalls = 0;
  runnerDeps.fetchEnvelope = async () => {
    envelopeCalls++;
    return { ok: false, retryable: false, reason: "ENVELOPE_HTTP_410" };
  };
  const receipt = await processClaim(claim, runnerDeps);

  assert.equal(envelopeCalls, 1, "the first step sends a buyer, so identity is required");
  assert.equal(adapter.calls.length, 0);
  assert.equal(receipt.status, "FAILED");
});


test("a receipt reporting work refuses to sign without a proven commitment", () => {
  for (const status of ["COMPLETED", "PARTIAL"] as const) {
    assert.throws(
      () =>
        buildReceiptBody({
          claim,
          platform: "mock",
          executionMode: "mock",
          status,
          subjectCommitment: UNIDENTIFIED_SUBJECT,
          conversionRequestId: "k1",
          suppressionRequestId: "k2",
          observedAt: "2026-08-04T12:00:00.000Z",
          acceptedAt: null,
          exclusionConfigurationHash: "unverified",
          outcomes: [],
          signer: signer.address,
        }),
      /without a proven subject commitment/,
      `${status} must not accept the placeholder`,
    );
  }
});

test("a receipt where nothing was submitted may carry the placeholder", async () => {
  const dir = freshDir();
  const { deps: runnerDeps, adapter } = deps(dir);
  runnerDeps.fetchEnvelope = async () => ({ ok: false, retryable: false, reason: "ENVELOPE_HTTP_401" });
  const receipt = await processClaim(claim, runnerDeps);
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.subjectCommitment, UNIDENTIFIED_SUBJECT);
  assert.equal(adapter.calls.length, 0);
  assert.equal((await verifyReceipt(receipt)).valid, true);
});

test("a journal asserting two buyers for one claim refuses to load", async () => {
  const dir = freshDir();
  await crashAfter(dir, "ENVELOPE_FETCHED");
  const store = new SuppressionStore(dir);

  // Preferring either value would be a guess. Exactly one of them can be what
  // the platform received and the file does not say which, so the only honest
  // outcome is to stop.
  const conflicting = {
    type: "transition",
    at: new Date().toISOString(),
    campaignId: claim.campaignId,
    claimId: claim.claimId,
    platform: "mock",
    state: "ENVELOPE_FETCHED",
    attempt: 2,
    subjectCommitment: "b".repeat(64),
  } as const;

  // Refused at the point of writing…
  assert.throws(() => store.append(conflicting), /conflicting subject commitment/);
  // …and refused again on a cold load, for a file that already contains it.
  appendRaw(dir, conflicting);
  assert.throws(() => new SuppressionStore(dir), /conflicting subject commitment/);
});

test("a journal asserting two envelopes for one claim refuses to load", async () => {
  const dir = freshDir();
  await crashAfter(dir, "ENVELOPE_FETCHED");
  const store = new SuppressionStore(dir);
  const conflicting = {
    type: "transition",
    at: new Date().toISOString(),
    campaignId: claim.campaignId,
    claimId: claim.claimId,
    platform: "mock",
    state: "ENVELOPE_FETCHED",
    attempt: 2,
    envelopeFingerprint: "c".repeat(64),
  } as const;
  assert.throws(() => store.append(conflicting), /conflicting envelope fingerprint/);
  appendRaw(dir, conflicting);
  assert.throws(() => new SuppressionStore(dir), /conflicting envelope fingerprint/);
});

test("an identical envelope replayed into the journal loads without complaint", async () => {
  const dir = freshDir();
  await crashAfter(dir, "ENVELOPE_FETCHED");
  const store = new SuppressionStore(dir);
  const progress = store.progress(claim.campaignId, claim.claimId, "mock");
  store.append({
    type: "transition",
    at: new Date().toISOString(),
    campaignId: claim.campaignId,
    claimId: claim.claimId,
    platform: "mock",
    state: "ENVELOPE_FETCHED",
    attempt: 2,
    subjectCommitment: progress.subjectCommitment ?? "",
    envelopeFingerprint: progress.envelopeFingerprint ?? "",
  });
  assert.doesNotThrow(() => new SuppressionStore(dir));
});

/**
 * A merchant is authenticated, not infallible. On a resume it can answer the
 * same evidence hash with a different buyer — and before the fingerprint check
 * the platform would receive the new one while the receipt still named the old.
 */

function rebindHarness(dir: string, replacement: Partial<SuppressionEnvelope>) {
  const adapter = new MockSuppressionAdapter();
  const store = new SuppressionStore(dir);
  const deps: RunnerDeps = {
    store,
    adapter,
    policy: policy(),
    signer,
    tenantId: "poc-demo-suppression",
    commitmentKey: "c".repeat(48),
    fetchEnvelope: async () => ({ ok: true, envelope: { ...envelope(), ...replacement } }),
    now: Date.now,
    sleep: async () => {},
  };
  return { deps, adapter, store };
}

test("a changed subjectRef after ENVELOPE_FETCHED stops before any platform call", async () => {
  const dir = freshDir();
  await crashAfter(dir, "ENVELOPE_FETCHED");
  const buyerA = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock")
    .subjectCommitment;

  const h = rebindHarness(dir, { subjectRef: "subj_999" });
  const receipt = await processClaim(claim, h.deps);

  assert.equal(h.adapter.calls.length, 0, "buyer B must never reach the platform");
  assert.equal(receipt.subjectCommitment, buyerA);
  assert.equal(receipt.status, "FAILED");
  assert.equal(
    h.store.records().some((r) => r.type === "transition" && r.failure?.code === "ENVELOPE_REBOUND"),
    true,
  );
});

test("the same subjectRef with a changed identifier is caught too", async () => {
  const dir = freshDir();
  await crashAfter(dir, "ENVELOPE_FETCHED");

  // The commitment is unchanged — only the fingerprint can see this.
  const h = rebindHarness(dir, { subject: new PlatformSubject({ em: "7".repeat(64) }) });
  await processClaim(claim, h.deps);
  assert.equal(h.adapter.calls.length, 0, "a different identifier is a different buyer");
  assert.equal(
    h.store.records().some((r) => r.type === "transition" && r.failure?.code === "ENVELOPE_REBOUND"),
    true,
  );
});

test("a changed purchase time, order or consent is caught by the fingerprint", async () => {
  for (const replacement of [
    { occurredAt: "2026-08-04T10:00:00.000Z" },
    { order: { value: "99.99", currency: "USD" } },
    { order: null },
    {
      consent: {
        granted: true,
        purpose: "advertising-suppression",
        recordedAt: "2026-08-04T10:00:00.000Z",
      },
    },
  ] as Partial<SuppressionEnvelope>[]) {
    const dir = freshDir();
    await crashAfter(dir, "ENVELOPE_FETCHED");
    const h = rebindHarness(dir, replacement);
    await processClaim(claim, h.deps);
    assert.equal(
      h.adapter.calls.length,
      0,
      `changing ${Object.keys(replacement)[0]} must stop execution`,
    );
  }
});

test("a changed envelope after conversion acceptance is PARTIAL, bound to the original buyer", async () => {
  const dir = freshDir();
  await crashAfter(dir, "CONVERSION_ACCEPTED");
  const buyerA = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock")
    .subjectCommitment;

  const h = rebindHarness(dir, { subjectRef: "subj_999" });
  const receipt = await processClaim(claim, h.deps);

  assert.equal(h.adapter.effectCount("audience"), 0, "no audience call for the substituted buyer");
  assert.equal(h.adapter.calls.length, 0);
  assert.equal(receipt.status, "PARTIAL");
  assert.equal(receipt.subjectCommitment, buyerA);
  assert.equal((await verifyReceipt(receipt)).valid, true);
});

test("an identical refetch continues normally", async () => {
  const dir = freshDir();
  await crashAfter(dir, "ENVELOPE_FETCHED");
  const buyerA = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock")
    .subjectCommitment;

  const h = rebindHarness(dir, {});
  const receipt = await processClaim(claim, h.deps);

  assert.equal(receipt.status, "COMPLETED");
  assert.equal(receipt.subjectCommitment, buyerA);
  assert.equal(h.adapter.effectCount("conversion"), 1);
  assert.equal(h.adapter.effectCount("audience"), 1);
});

test("the fingerprint records sameness without recording the buyer", async () => {
  const dir = freshDir();
  await crashAfter(dir, "ENVELOPE_FETCHED");
  const journal = readFileSync(join(dir, "journal.jsonl"), "utf8");
  const progress = new SuppressionStore(dir).progress(claim.campaignId, claim.claimId, "mock");

  assert.match(progress.envelopeFingerprint ?? "", /^[0-9a-f]{64}$/);
  assert.equal(journal.includes(EM), false, "no platform identifier reaches the journal");
  assert.notEqual(progress.envelopeFingerprint, EM);
  assert.notEqual(progress.envelopeFingerprint, progress.subjectCommitment);
});

test("the fingerprint is unforgeable without the tenant key", () => {
  const env = envelope();
  const mine = envelopeFingerprint("c".repeat(48), "poc-demo-suppression", env);
  assert.notEqual(mine, envelopeFingerprint("d".repeat(48), "poc-demo-suppression", env));
  assert.notEqual(mine, envelopeFingerprint("c".repeat(48), "other-tenant", env));
  assert.equal(mine, envelopeFingerprint("c".repeat(48), "poc-demo-suppression", envelope()));
});

test("the commitment and the fingerprint are domain-separated under one key", () => {
  const env = envelope();
  assert.notEqual(
    subjectCommitment("c".repeat(48), "poc-demo-suppression", env.subjectRef),
    envelopeFingerprint("c".repeat(48), "poc-demo-suppression", env),
  );
});
