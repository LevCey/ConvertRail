import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { MockSuppressionAdapter, type MockScript } from "./adapters/mock.ts";
import { processClaim, backoffMs, type RunnerDeps } from "./runner.ts";
import { verifyReceipt } from "./receipt.ts";
import { SuppressionStore } from "./store.ts";
import { PlatformSubject } from "./types.ts";
import type { SuppressionEnvelope, SuppressionPolicy, VerifiedClaim } from "./types.ts";

const signer = privateKeyToAccount(`0x${"42".repeat(32)}`);
const COMMITMENT_KEY = "c".repeat(48);
const EM = "9".repeat(64);
const PH = "8".repeat(64);

const claim: VerifiedClaim = {
  campaignId: `0x${"ab".repeat(32)}`,
  claimId: "7",
  evidenceHash: `0x${"cd".repeat(32)}`,
  verifiedAtBlock: "55149673",
};

const roots: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "convertrail-suppression-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function envelope(overrides: Partial<SuppressionEnvelope> = {}): SuppressionEnvelope {
  return {
    version: "convertrail.suppression.envelope/1",
    evidenceHash: claim.evidenceHash,
    subjectRef: "subj_017",
    subject: new PlatformSubject({ em: EM, ph: PH }),
    occurredAt: "2026-08-04T11:58:00.000Z",
    order: { value: "49.99", currency: "USD" },
    consent: { granted: true, purpose: "advertising-suppression", recordedAt: "2026-08-04T11:59:00.000Z" },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
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

interface Harness {
  deps: RunnerDeps;
  adapter: MockSuppressionAdapter;
  store: SuppressionStore;
  dir: string;
  envelopeCalls: number;
}

function harness(options: {
  script?: MockScript;
  policy?: Partial<SuppressionPolicy>;
  envelope?: Partial<SuppressionEnvelope> | null;
  envelopeFailures?: number;
  dir?: string;
} = {}): Harness {
  const dir = options.dir ?? freshDir();
  const adapter = new MockSuppressionAdapter(options.script);
  const store = new SuppressionStore(dir);
  const harnessState = { envelopeCalls: 0 };
  let remainingFailures = options.envelopeFailures ?? 0;

  const deps: RunnerDeps = {
    store,
    adapter,
    policy: policy(options.policy),
    signer,
    tenantId: "poc-demo-suppression",
    commitmentKey: COMMITMENT_KEY,
    fetchEnvelope: async () => {
      harnessState.envelopeCalls++;
      if (remainingFailures > 0) {
        remainingFailures--;
        return { ok: false, retryable: true, reason: "ENVELOPE_TRANSPORT:TimeoutError" };
      }
      if (options.envelope === null) {
        return { ok: false, retryable: false, reason: "ENVELOPE_HTTP_401" };
      }
      return { ok: true, envelope: envelope(options.envelope) };
    },
    now: Date.now,
    sleep: async () => {},
  };

  return {
    deps,
    adapter,
    store,
    dir,
    get envelopeCalls() {
      return harnessState.envelopeCalls;
    },
  };
}

function journal(dir: string): string {
  return readFileSync(join(dir, "journal.jsonl"), "utf8");
}

test("one verified claim produces exactly one conversion dispatch and one audience write", async () => {
  const h = harness();
  const receipt = await processClaim(claim, h.deps);
  assert.equal(h.adapter.effectCount("conversion"), 1);
  assert.equal(h.adapter.effectCount("audience"), 1);
  assert.equal(h.adapter.effectCount("exclusion-check"), 1);
  assert.equal(receipt.status, "COMPLETED");
});

test("the exclusion configuration is checked and committed to by the receipt", async () => {
  const h = harness({ script: { coverage: { targeted: 2, observed: 2, excluding: 2, unresolved: [] } } });
  const receipt = await processClaim(claim, h.deps);
  assert.notEqual(receipt.exclusionConfigurationHash, "unverified");
  assert.match(receipt.exclusionConfigurationHash, /^0x[0-9a-f]{64}$/);
});

test("exactly one valid signed receipt is produced and it verifies cold", async () => {
  const h = harness();
  const receipt = await processClaim(claim, h.deps);
  assert.equal((await verifyReceipt(receipt)).valid, true);
  assert.equal(h.store.receipts().length, 1);
  assert.equal(receipt.verifiedAtBlock, "55149673");
  assert.equal(receipt.trigger, "VERIFIED");
});

test("the SLA anchor is present and acceptance is timed from the audience write", async () => {
  const h = harness();
  const receipt = await processClaim(claim, h.deps);
  assert.equal(typeof receipt.acceptedAt, "string");
  assert.equal(Date.parse(receipt.acceptedAt ?? "") >= Date.parse(receipt.observedAt), true);
});

test("a transient platform failure retries under the same key and then succeeds", async () => {
  const h = harness({ script: { conversion: ["transient", "transient", "accepted"] } });
  const receipt = await processClaim(claim, h.deps);
  assert.equal(receipt.status, "COMPLETED");
  assert.equal(h.adapter.effectCount("conversion"), 1);
  assert.equal(h.adapter.calls.filter((c) => c.action === "conversion").length, 3);
  const keys = new Set(h.adapter.calls.filter((c) => c.action === "conversion").map((c) => c.idempotencyKey));
  assert.equal(keys.size, 1);
  const eventIds = new Set(h.adapter.calls.filter((c) => c.action === "conversion").map((c) => c.eventId));
  assert.equal(eventIds.size, 1);
});

test("an unknown result is retried rather than recorded as acceptance", async () => {
  const h = harness({ script: { conversion: ["unknown", "accepted"] } });
  const receipt = await processClaim(claim, h.deps);
  assert.equal(receipt.status, "COMPLETED");
  assert.equal(journal(h.dir).includes("RETRY_SCHEDULED"), true);
});

test("a permanent failure yields a signed FAILED receipt and a dead letter", async () => {
  const h = harness({ script: { conversion: ["permanent"] } });
  const receipt = await processClaim(claim, h.deps);
  assert.equal(receipt.status, "FAILED");
  assert.equal((await verifyReceipt(receipt)).valid, true);
  assert.equal(h.adapter.effectCount("audience"), 0);
  const deadLetters = h.store.records().filter((r) => r.type === "dead-letter");
  assert.equal(deadLetters.length, 1);
});

test("a failed audience write with an accepted conversion is PARTIAL, never COMPLETED", async () => {
  const h = harness({ script: { conversion: ["accepted"], audience: ["permanent"] } });
  const receipt = await processClaim(claim, h.deps);
  assert.equal(receipt.status, "PARTIAL");
  assert.equal(receipt.acceptedAt, null);
  assert.equal(receipt.exclusionConfigurationHash, "unverified");
  assert.equal((await verifyReceipt(receipt)).valid, true);
});

test("a failed exclusion check does not erase the work that succeeded", async () => {
  const h = harness({ script: { exclusion: ["permanent"] } });
  const receipt = await processClaim(claim, h.deps);
  assert.equal(receipt.status, "PARTIAL");
  assert.equal(typeof receipt.acceptedAt, "string");
  assert.equal(h.adapter.effectCount("audience"), 1);
});

test("exhausting the attempt budget stops the work and still produces a receipt", async () => {
  const h = harness({ script: { conversion: ["transient"] }, policy: { maxAttempts: 3 } });
  const receipt = await processClaim(claim, h.deps);
  assert.equal(receipt.status, "FAILED");
  assert.equal(h.adapter.calls.filter((c) => c.action === "conversion").length, 3);
});

test("withheld consent is a deliberate skip, not a failure, and touches no platform", async () => {
  const h = harness({
    envelope: { consent: { granted: false, purpose: "advertising-suppression", recordedAt: "2026-08-04T11:59:00.000Z" } },
  });
  const receipt = await processClaim(claim, h.deps);
  assert.equal(receipt.status, "SKIPPED");
  assert.equal(h.adapter.calls.length, 0);
  assert.equal((await verifyReceipt(receipt)).valid, true);
});

test("a disabled policy performs no work and records why", async () => {
  const h = harness({ policy: { enabled: false } });
  const receipt = await processClaim(claim, h.deps);
  assert.equal(receipt.status, "SKIPPED");
  assert.equal(h.adapter.calls.length, 0);
  assert.equal(h.envelopeCalls, 0);
});

test("an unauthorised envelope fetch is permanent and is not retried", async () => {
  const h = harness({ envelope: null });
  const receipt = await processClaim(claim, h.deps);
  assert.equal(receipt.status, "FAILED");
  assert.equal(h.envelopeCalls, 1);
  assert.equal(h.adapter.calls.length, 0);
});

test("a transport failure fetching the envelope is retried", async () => {
  const h = harness({ envelopeFailures: 2 });
  const receipt = await processClaim(claim, h.deps);
  assert.equal(receipt.status, "COMPLETED");
  assert.equal(h.envelopeCalls, 3);
});

test("restart and replay produce no duplicate actions", async () => {
  const dir = freshDir();
  const first = harness({ dir });
  const receipt = await processClaim(claim, first.deps);

  const second = harness({ dir });
  const replayed = await processClaim(claim, second.deps);
  assert.equal(second.adapter.calls.length, 0);
  assert.equal(second.envelopeCalls, 0);
  assert.deepEqual(replayed, receipt);
});

test("a crash after the conversion landed does not re-dispatch it on restart", async () => {
  const dir = freshDir();
  const crashed = new SuppressionStore(dir);
  crashed.append({
    type: "intent",
    at: "2026-08-04T12:00:00.000Z",
    campaignId: claim.campaignId,
    claimId: claim.claimId,
    evidenceHash: claim.evidenceHash,
    platform: "mock",
    verifiedAtBlock: claim.verifiedAtBlock,
  });
  crashed.append({
    type: "transition",
    at: "2026-08-04T12:00:01.000Z",
    campaignId: claim.campaignId,
    claimId: claim.claimId,
    platform: "mock",
    state: "CONVERSION_ACCEPTED",
    attempt: 1,
  });

  const resumed = harness({ dir });
  const receipt = await processClaim(claim, resumed.deps);
  assert.equal(receipt.status, "COMPLETED");
  assert.equal(resumed.adapter.effectCount("conversion"), 0);
  assert.equal(resumed.adapter.effectCount("audience"), 1);
});

test("a truncated journal aborts the restart instead of resuming from a partial view", () => {
  const dir = freshDir();
  const store = new SuppressionStore(dir);
  store.append({
    type: "intent",
    at: "2026-08-04T12:00:00.000Z",
    campaignId: claim.campaignId,
    claimId: claim.claimId,
    evidenceHash: claim.evidenceHash,
    platform: "mock",
    verifiedAtBlock: claim.verifiedAtBlock,
  });
  const path = join(dir, "journal.jsonl");
  const contents = readFileSync(path, "utf8");
  writeFileSync(path, `${contents}{"type":"transiti`);
  assert.throws(() => new SuppressionStore(dir), /refusing to resume from a partial history/);
});

test("the store recognises a claim it has already taken responsibility for", async () => {
  const h = harness();
  assert.equal(h.store.known(claim.campaignId, claim.claimId, "mock"), false);
  await processClaim(claim, h.deps);
  assert.equal(h.store.known(claim.campaignId, claim.claimId, "mock"), true);
  assert.equal(h.store.known(claim.campaignId, "8", "mock"), false);
});

test("the cursor round-trips and is ignored for a different campaign", () => {
  const dir = freshDir();
  const store = new SuppressionStore(dir);
  assert.equal(store.readCursor(claim.campaignId), undefined);
  store.writeCursor(claim.campaignId, 55_149_673n);
  assert.equal(new SuppressionStore(dir).readCursor(claim.campaignId), 55_149_673n);
  assert.equal(new SuppressionStore(dir).readCursor(`0x${"ff".repeat(32)}`), undefined);
});

test("no identifier reaches the journal, the receipt or the adapter record", async () => {
  const h = harness({ script: { conversion: ["transient", "accepted"], audience: ["permanent"] } });
  const receipt = await processClaim(claim, h.deps);
  const surfaces = [journal(h.dir), JSON.stringify(receipt), JSON.stringify(h.adapter.calls)];
  for (const surface of surfaces) {
    assert.equal(surface.includes(EM), false);
    assert.equal(surface.includes(PH), false);
    assert.equal(surface.includes("subj_017"), false);
    assert.equal(/[^\s@"]+@[^\s@"]+\.[^\s@"]+/.test(surface), false);
  }
});

test("the subject commitment is keyed, so the receipt is not a cross-advertiser join key", async () => {
  const h = harness();
  const receipt = await processClaim(claim, h.deps);
  assert.match(receipt.subjectCommitment, /^[0-9a-f]{64}$/);
  assert.notEqual(receipt.subjectCommitment, EM);
  assert.notEqual(receipt.subjectCommitment, PH);
});

test("the adapter offers no way to remove a buyer from an exclusion audience", () => {
  const adapter = new MockSuppressionAdapter();
  const methods = new Set<string>();
  for (let proto = Object.getPrototypeOf(adapter); proto; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) methods.add(name.toLowerCase());
  }
  for (const forbidden of ["remove", "delete", "unsuppress", "clear"]) {
    assert.equal(
      [...methods].some((m) => m.includes(forbidden)),
      false,
      `no adapter method may ${forbidden} audience membership`,
    );
  }
});

test("a dispute is an amendment: it is recorded and removes nobody", async () => {
  const h = harness();
  const receipt = await processClaim(claim, h.deps);
  const callsBefore = h.adapter.calls.length;

  h.store.append({
    type: "transition",
    at: "2026-08-04T12:10:00.000Z",
    campaignId: claim.campaignId,
    claimId: claim.claimId,
    platform: "mock",
    state: "AMENDED",
    attempt: 0,
    failure: { permanent: false, code: "DISPUTED_AT_BLOCK_55149700" },
  });

  assert.equal(h.adapter.calls.length, callsBefore);
  // The receipt already issued stays valid: it says the buyer was submitted,
  // which the dispute does not make untrue.
  assert.equal((await verifyReceipt(receipt)).valid, true);
  assert.equal(h.store.records().some((r) => r.type === "transition" && r.state === "AMENDED"), true);
});

test("the watcher takes intake only from verified claims", () => {
  const source = readFileSync(new URL("./agent.ts", import.meta.url), "utf8");
  assert.equal(source.includes('eventName: "ClaimVerified"'), true);
  for (const event of ["ClaimRejected", "ClaimSubmitted", "ClaimSettled"]) {
    assert.equal(source.includes(`eventName: "${event}"`), false, `must not act on ${event}`);
  }
});

test("backoff grows and then holds at a ceiling", () => {
  assert.equal(backoffMs(1), 1000);
  assert.equal(backoffMs(2), 2000);
  assert.equal(backoffMs(6), 30_000);
  assert.equal(backoffMs(60), 30_000);
});
