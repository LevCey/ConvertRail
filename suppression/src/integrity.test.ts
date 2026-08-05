import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { exclusionIsComplete, executionModeFor } from "./core.ts";
import { buildReceiptBody, verifyReceipt } from "./receipt.ts";
import { processClaim, type RunnerDeps } from "./runner.ts";
import { SuppressionStore } from "./store.ts";
import { MockSuppressionAdapter, type MockScript } from "./adapters/mock.ts";
import { MetaSuppressionAdapter, type MetaConfig } from "./adapters/meta.ts";
import { PlatformSubject } from "./types.ts";
import type {
  ExclusionCoverage,
  SuppressionEnvelope,
  SuppressionPolicy,
  VerifiedClaim,
} from "./types.ts";

/**
 * The three claims a receipt makes that are easiest to overstate: that the
 * exclusion is in place, that the submission was real, and that the purchase
 * figures came from the merchant.
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
  const dir = mkdtempSync(join(tmpdir(), "convertrail-integrity-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const OCCURRED_AT = new Date(Date.now() - 90_000).toISOString();

function envelope(overrides: Partial<SuppressionEnvelope> = {}): SuppressionEnvelope {
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
      recordedAt: "2026-08-04T11:57:00.000Z",
    },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    merchantSignature: `0x${"11".repeat(65)}`,
    ...overrides,
  };
}

function run(options: {
  script?: MockScript;
  policy?: Partial<SuppressionPolicy>;
  envelope?: Partial<SuppressionEnvelope>;
} = {}) {
  const adapter = new MockSuppressionAdapter(options.script);
  const deps: RunnerDeps = {
    store: new SuppressionStore(freshDir()),
    adapter,
    policy: {
      platform: "mock",
      trigger: "VERIFIED",
      enabled: true,
      dryRun: false,
      maxAttempts: 5,
      slaSeconds: 300,
      ...options.policy,
    },
    signer,
    tenantId: "poc-demo-suppression",
    commitmentKey: "c".repeat(48),
    fetchEnvelope: async () => ({ ok: true, envelope: envelope(options.envelope) }),
    now: Date.now,
    sleep: async () => {},
  };
  return { deps, adapter };
}

function coverage(overrides: Partial<ExclusionCoverage> = {}): ExclusionCoverage {
  return { targeted: 3, observed: 3, excluding: 3, unresolved: [], ...overrides };
}

// --- Exclusion completeness -------------------------------------------------

test("completeness requires a declared scope, full observation and full exclusion", () => {
  assert.equal(exclusionIsComplete(coverage()), true);
  assert.equal(exclusionIsComplete(undefined), false);
  assert.equal(
    exclusionIsComplete(coverage({ targeted: 0, observed: 0, excluding: 0 })),
    false,
    "an empty scope is 0/0, which proves nothing",
  );
  assert.equal(
    exclusionIsComplete(coverage({ excluding: 2 })),
    false,
    "partial coverage is not completion",
  );
  assert.equal(
    exclusionIsComplete(coverage({ observed: 2, excluding: 2 })),
    false,
    "an ad set we never read is not an ad set we confirmed",
  );
  assert.equal(
    exclusionIsComplete(coverage({ unresolved: ["300"] })),
    false,
    "an inaccessible target blocks completion",
  );
  assert.equal(
    exclusionIsComplete(coverage({ targeted: 3, observed: 3, excluding: 0 })),
    false,
    "zero coverage is not completion",
  );
});

test("partial exclusion coverage produces PARTIAL, never COMPLETED", async () => {
  const { deps } = run({ script: { coverage: coverage({ excluding: 2 }) } });
  const receipt = await processClaim(claim, deps);
  assert.equal(receipt.status, "PARTIAL");
});

test("an unresolved target ad set produces PARTIAL", async () => {
  const { deps } = run({ script: { coverage: coverage({ observed: 2, excluding: 2, unresolved: ["300"] }) } });
  const receipt = await processClaim(claim, deps);
  assert.equal(receipt.status, "PARTIAL");
});

test("an empty target scope produces PARTIAL rather than a vacuous pass", async () => {
  const { deps } = run({ script: { coverage: coverage({ targeted: 0, observed: 0, excluding: 0 }) } });
  const receipt = await processClaim(claim, deps);
  assert.equal(receipt.status, "PARTIAL");
  assert.equal(receipt.exclusionConfigurationHash, "unverified");
});

test("incomplete coverage is recorded as a reason, not silently downgraded", async () => {
  const { deps } = run({ script: { coverage: coverage({ excluding: 1 }) } });
  await processClaim(claim, deps);
  const journal = deps.store.records();
  const failure = journal.find(
    (r) => r.type === "transition" && r.failure?.code === "EXCLUSION_INCOMPLETE",
  );
  assert.notEqual(failure, undefined);
});

test("Meta refuses an exclusion check with no declared target scope", async () => {
  const config: MetaConfig = {
    apiVersion: "v25.0",
    accessToken: "token",
    pixelId: "1",
    audienceId: "2",
    adAccountId: "act_3",
    acquisitionAdSetIds: [],
    baseUrl: "https://graph.example.invalid",
    timeoutMs: 1000,
  };
  const outcome = await new MetaSuppressionAdapter(config).verifyExclusionConfiguration({
    idempotencyKey: "k",
    dryRun: false,
  });
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.failure?.code, "META_NO_EXCLUSION_TARGETS");
});

// --- Dry-run and live separation --------------------------------------------

test("the execution mode is derived from the platform and the dry-run flag", () => {
  const base = { trigger: "VERIFIED", enabled: true, maxAttempts: 5, slaSeconds: 300 } as const;
  assert.equal(executionModeFor({ ...base, platform: "mock", dryRun: false }), "mock");
  assert.equal(executionModeFor({ ...base, platform: "mock", dryRun: true }), "mock");
  assert.equal(executionModeFor({ ...base, platform: "meta", dryRun: true }), "dry-run");
  assert.equal(executionModeFor({ ...base, platform: "meta", dryRun: false }), "live");
});

test("a mock run is signed as mock, never as live", async () => {
  const { deps } = run();
  const receipt = await processClaim(claim, deps);
  assert.equal(receipt.executionMode, "mock");
  assert.notEqual(receipt.executionMode, "live");
  assert.equal(receipt.status, "COMPLETED");
});

test("a dry run and a live submission for the same claim cannot share a receipt id", () => {
  const shared = {
    claim,
    platform: "meta" as const,
    status: "COMPLETED" as const,
    subjectCommitment: "a".repeat(64),
    conversionRequestId: "k1",
    suppressionRequestId: "k2",
    observedAt: "2026-08-04T12:00:00.000Z",
    acceptedAt: "2026-08-04T12:00:04.000Z",
    exclusionConfigurationHash: "e".repeat(64),
    signer: signer.address,
  };
  const live = buildReceiptBody({ ...shared, executionMode: "live", outcomes: [{ detail: { ok: true } }] });
  const dry = buildReceiptBody({ ...shared, executionMode: "dry-run", outcomes: [{ detail: { dryRun: true } }] });
  assert.notEqual(live.receiptId, dry.receiptId);
});

test("a live receipt cannot be signed over simulated outcomes", () => {
  assert.throws(
    () =>
      buildReceiptBody({
        claim,
        platform: "meta",
        executionMode: "live",
        status: "COMPLETED",
        subjectCommitment: "a".repeat(64),
        conversionRequestId: "k1",
        suppressionRequestId: "k2",
        observedAt: "2026-08-04T12:00:00.000Z",
        acceptedAt: null,
        exclusionConfigurationHash: "unverified",
        outcomes: [{ detail: { dryRun: true } }],
        signer: signer.address,
      }),
    /live receipt over simulated outcomes/,
  );
});

test("a dry-run receipt cannot be signed over live outcomes", () => {
  assert.throws(
    () =>
      buildReceiptBody({
        claim,
        platform: "meta",
        executionMode: "dry-run",
        status: "COMPLETED",
        subjectCommitment: "a".repeat(64),
        conversionRequestId: "k1",
        suppressionRequestId: "k2",
        observedAt: "2026-08-04T12:00:00.000Z",
        acceptedAt: null,
        exclusionConfigurationHash: "unverified",
        outcomes: [{ detail: { eventsReceived: 1 } }],
        signer: signer.address,
      }),
    /dry-run receipt over live outcomes/,
  );
});

test("Meta refuses a live audience write while a test event code is configured", async () => {
  const config: MetaConfig = {
    apiVersion: "v25.0",
    accessToken: "token",
    pixelId: "1",
    audienceId: "2",
    adAccountId: "act_3",
    acquisitionAdSetIds: ["100"],
    testEventCode: "TEST1234",
    baseUrl: "https://graph.example.invalid",
    timeoutMs: 1000,
  };
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return { ok: true, status: 200, json: async () => ({ num_received: 1 }) } as Response;
  }) as typeof fetch;
  try {
    const outcome = await new MetaSuppressionAdapter(config).addToExclusionAudience({
      idempotencyKey: "k",
      subject: new PlatformSubject({ em: EM }),
      dryRun: false,
    });
    assert.equal(requests, 0, "the write must not reach the network");
    assert.equal(outcome.kind, "rejected");
    assert.equal(outcome.failure?.code, "META_TEST_MODE_LIVE_AUDIENCE");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- Purchase data ----------------------------------------------------------

test("the conversion carries the merchant's timestamp, not the submission time", async () => {
  const { deps, adapter } = run();
  await processClaim(claim, deps);
  const call = adapter.calls.find((c) => c.action === "conversion");
  assert.equal(call?.occurredAtUnix, Math.floor(Date.parse(OCCURRED_AT) / 1000));
  assert.notEqual(call?.occurredAtUnix, Math.floor(Date.now() / 1000));
});

test("the merchant's order value is passed through unchanged", async () => {
  const { deps, adapter } = run();
  await processClaim(claim, deps);
  const call = adapter.calls.find((c) => c.action === "conversion");
  assert.deepEqual(call?.order, { value: "49.99", currency: "USD" });
});

test("no order value means none is sent, rather than one being invented", async () => {
  const { deps, adapter } = run({ envelope: { order: null } });
  await processClaim(claim, deps);
  const call = adapter.calls.find((c) => c.action === "conversion");
  assert.equal(call?.order, null);
});

test("the campaign payout never reaches the conversion as a purchase value", async () => {
  const { deps, adapter } = run({ envelope: { order: null } });
  await processClaim(claim, deps);
  const serialised = JSON.stringify(adapter.calls);
  // The demo campaign price is atomic USDC; neither it nor the token symbol may
  // appear as purchase data.
  assert.equal(serialised.includes("USDC"), false);
  assert.equal(/"value":"\d{4,}"/.test(serialised), false, "no atomic-unit amount was sent");
});

test("Meta omits custom_data entirely when there is no order value", async () => {
  const config: MetaConfig = {
    apiVersion: "v25.0",
    accessToken: "token",
    pixelId: "1234567890",
    audienceId: "2",
    adAccountId: "act_3",
    acquisitionAdSetIds: ["100"],
    baseUrl: "https://graph.example.invalid",
    timeoutMs: 1000,
  };
  const realFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return { ok: true, status: 200, json: async () => ({ events_received: 1 }) } as Response;
  }) as typeof fetch;
  try {
    await new MetaSuppressionAdapter(config).sendConversion({
      idempotencyKey: "k",
      eventId: "e".repeat(32),
      occurredAtUnix: 1_785_000_000,
      order: null,
      subject: new PlatformSubject({ em: EM }),
      dryRun: false,
    });
    const event = (body.data as Array<Record<string, unknown>>)[0];
    assert.equal("custom_data" in event, false);
    assert.equal(event.event_time, 1_785_000_000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- Meta dry run: zero network, honest receipt ------------------------------

test("a full Meta dry run makes no network request and still signs a receipt", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("a dry run must not reach the network");
  }) as typeof fetch;

  try {
    const adapter = new MetaSuppressionAdapter({
      apiVersion: "v25.0",
      accessToken: "token",
      pixelId: "1234567890",
      audienceId: "9876543210",
      adAccountId: "act_555000111",
      acquisitionAdSetIds: ["100", "200"],
      baseUrl: "https://graph.example.invalid",
      timeoutMs: 1000,
    });
    const store = new SuppressionStore(freshDir());
    const receipt = await processClaim(claim, {
      store,
      adapter,
      policy: {
        platform: "meta",
        trigger: "VERIFIED",
        enabled: true,
        dryRun: true,
        maxAttempts: 5,
        slaSeconds: 300,
      },
      signer,
      tenantId: "poc-demo-suppression",
      commitmentKey: "c".repeat(48),
      fetchEnvelope: async () => ({ ok: true, envelope: envelope() }),
      now: Date.now,
      sleep: async () => {},
    });

    assert.equal(receipt.executionMode, "dry-run");
    // Nothing was read from Meta, so nothing about the exclusion was
    // established. PARTIAL is the honest ceiling for a dry run.
    assert.equal(receipt.status, "PARTIAL");
    assert.equal(receipt.exclusionConfigurationHash, "unverified");
    assert.equal((await verifyReceipt(receipt)).valid, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a dry-run exclusion check reports the scope it would have inspected", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("a dry run must not reach the network");
  }) as typeof fetch;
  try {
    const outcome = await new MetaSuppressionAdapter({
      apiVersion: "v25.0",
      accessToken: "token",
      pixelId: "1",
      audienceId: "2",
      adAccountId: "act_3",
      acquisitionAdSetIds: ["200", "100"],
      baseUrl: "https://graph.example.invalid",
      timeoutMs: 1000,
    }).verifyExclusionConfiguration({ idempotencyKey: "k", dryRun: true });

    assert.equal(outcome.detail.dryRun, true);
    assert.equal(outcome.platformRef, "dryrun_exclusion");
    assert.deepEqual(outcome.coverage, {
      targeted: 2,
      observed: 0,
      excluding: 0,
      unresolved: ["100", "200"],
    });
    assert.equal(outcome.configurationDigest, undefined, "nothing was observed to digest");
    assert.equal(exclusionIsComplete(outcome.coverage), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a dry run records an absence of evidence, not an operational failure", async () => {
  const { deps } = run({ policy: { dryRun: true } });
  const receipt = await processClaim(claim, deps);
  const records = deps.store.records();

  assert.equal(receipt.status, "PARTIAL");
  assert.equal(
    records.some((r) => r.type === "transition" && r.state === "EXCLUSION_UNVERIFIED"),
    true,
  );
  assert.equal(records.some((r) => r.type === "dead-letter"), false, "a dry run is not a dead letter");
  assert.equal(
    records.some((r) => r.type === "transition" && r.failure?.code === "EXCLUSION_INCOMPLETE"),
    false,
  );
});

test("an unverified exclusion is never retried into a completion", async () => {
  const { deps, adapter } = run({ policy: { dryRun: true } });
  await processClaim(claim, deps);
  assert.equal(adapter.effectCount("exclusion-check"), 1, "the check runs once and stops");
  const receipt = deps.store.receipt(claim.campaignId, claim.claimId, "mock");
  assert.equal(receipt?.status, "PARTIAL");
});
