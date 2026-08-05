import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { auditReceipts, computeMetrics, percentiles } from "./telemetry.ts";
import type { StoreRecord } from "./store.ts";
import type { SuppressionPolicy, SuppressionReceipt } from "./types.ts";

const policy: SuppressionPolicy = {
  platform: "mock",
  trigger: "VERIFIED",
  enabled: true,
  dryRun: false,
  maxAttempts: 5,
  slaSeconds: 300,
};

const BASE = Date.parse("2026-08-04T12:00:00.000Z");

function receipt(overrides: Partial<SuppressionReceipt> = {}): SuppressionReceipt {
  return {
    version: "convertrail.suppression.receipt/1",
    receiptId: "sr_000000000000000000000001",
    campaignId: `0x${"ab".repeat(32)}`,
    claimId: "1",
    evidenceHash: `0x${"cd".repeat(32)}`,
    platform: "mock",
    executionMode: "mock",
    trigger: "VERIFIED",
    verifiedAtBlock: "55149673",
    subjectCommitment: "a".repeat(64),
    conversionRequestId: "k1",
    suppressionRequestId: "k2",
    observedAt: new Date(BASE).toISOString(),
    acceptedAt: new Date(BASE + 4000).toISOString(),
    exclusionConfigurationHash: "e".repeat(64),
    status: "COMPLETED",
    responseDigest: "d".repeat(64),
    signer: "0x0000000000000000000000000000000000000001",
    signature: `0x${"11".repeat(65)}`,
    ...overrides,
  };
}

function intent(claimId: string): StoreRecord {
  return {
    type: "intent",
    at: new Date(BASE).toISOString(),
    campaignId: `0x${"ab".repeat(32)}`,
    claimId,
    evidenceHash: `0x${"cd".repeat(32)}`,
    platform: "mock",
    verifiedAtBlock: "55149673",
  };
}

test("an empty journal yields nulls rather than invented zeros", () => {
  const metrics = computeMetrics([], policy);
  assert.equal(metrics.intents, 0);
  assert.equal(metrics.byMode.mock.observationToAcceptanceMs, null);
  assert.equal(metrics.byMode.mock.slaAttainment, null);
  assert.equal(metrics.exclusionCoverage, null);
});

test("statuses are counted from stored receipts", () => {
  const metrics = computeMetrics(
    [
      intent("1"),
      intent("2"),
      intent("3"),
      { type: "receipt", at: "", receipt: receipt({ status: "COMPLETED" }) },
      { type: "receipt", at: "", receipt: receipt({ status: "PARTIAL", acceptedAt: null }) },
      { type: "receipt", at: "", receipt: receipt({ status: "SKIPPED", acceptedAt: null }) },
    ],
    policy,
  );
  assert.equal(metrics.intents, 3);
  assert.equal(metrics.byMode.mock.receipts, 3);
  assert.deepEqual(metrics.byMode.mock.byStatus, { COMPLETED: 1, PARTIAL: 1, FAILED: 0, SKIPPED: 1 });
});

test("latency is measured only where acceptance happened, and says so", () => {
  const metrics = computeMetrics(
    [
      { type: "receipt", at: "", receipt: receipt({ acceptedAt: new Date(BASE + 1000).toISOString() }) },
      { type: "receipt", at: "", receipt: receipt({ acceptedAt: new Date(BASE + 9000).toISOString() }) },
      { type: "receipt", at: "", receipt: receipt({ status: "FAILED", acceptedAt: null }) },
    ],
    policy,
  );
  assert.equal(metrics.byMode.mock.observationToAcceptanceMs?.count, 2);
  assert.equal(metrics.byMode.mock.observationToAcceptanceMs?.max, 9000);
  assert.equal(metrics.byMode.mock.slaAttainment?.measured, 2);
  assert.equal(metrics.byMode.mock.receipts, 3);
});

test("SLA attainment counts only acceptances inside the window", () => {
  const metrics = computeMetrics(
    [
      { type: "receipt", at: "", receipt: receipt({ acceptedAt: new Date(BASE + 300_000).toISOString() }) },
      { type: "receipt", at: "", receipt: receipt({ acceptedAt: new Date(BASE + 300_001).toISOString() }) },
    ],
    policy,
  );
  assert.deepEqual(metrics.byMode.mock.slaAttainment, { within: 1, measured: 2 });
});

test("retries, dead letters, amendments and skip reasons are all replayed", () => {
  const metrics = computeMetrics(
    [
      { type: "transition", at: "", campaignId: "c", claimId: "1", platform: "mock", state: "RETRY_SCHEDULED", attempt: 1 },
      { type: "transition", at: "", campaignId: "c", claimId: "1", platform: "mock", state: "RETRY_SCHEDULED", attempt: 2 },
      { type: "transition", at: "", campaignId: "c", claimId: "2", platform: "mock", state: "SKIPPED", attempt: 0, skipReason: "NO_CONSENT" },
      { type: "transition", at: "", campaignId: "c", claimId: "3", platform: "mock", state: "AMENDED", attempt: 0 },
      { type: "dead-letter", at: "", campaignId: "c", claimId: "4", platform: "mock", code: "X", attempts: 5 },
    ],
    policy,
  );
  assert.equal(metrics.retries, 2);
  assert.equal(metrics.amendments, 1);
  assert.equal(metrics.deadLetters, 1);
  assert.deepEqual(metrics.skips, { NO_CONSENT: 1 });
});

test("the most recent observed exclusion coverage is reported as a fraction", () => {
  const metrics = computeMetrics(
    [
      { type: "transition", at: "", campaignId: "c", claimId: "1", platform: "mock", state: "EXCLUSION_VERIFIED", attempt: 1, outcome: { coverage: { targeted: 3, observed: 3, excluding: 1, unresolved: [] } } },
      { type: "transition", at: "", campaignId: "c", claimId: "2", platform: "mock", state: "EXCLUSION_VERIFIED", attempt: 1, outcome: { coverage: { targeted: 3, observed: 3, excluding: 3, unresolved: [] } } },
    ],
    policy,
  );
  assert.deepEqual(metrics.exclusionCoverage, { targeted: 3, observed: 3, excluding: 3, unresolved: [] });
});

test("percentiles are nearest-rank, so every reported value was observed", () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const p = percentiles(values);
  assert.equal(p?.p50, 50);
  assert.equal(p?.p90, 90);
  assert.equal(p?.p99, 100);
  assert.equal(p?.max, 100);
  assert.equal(p?.count, 10);
  assert.equal(values[0], 10, "input must not be mutated");
});

test("a single sample does not produce a spread it cannot support", () => {
  assert.deepEqual(percentiles([7]), { p50: 7, p90: 7, p99: 7, max: 7, count: 1 });
  assert.equal(percentiles([]), null);
});

test("a clock skewed backwards is discarded rather than recorded as negative latency", () => {
  const metrics = computeMetrics(
    [{ type: "receipt", at: "", receipt: receipt({ acceptedAt: new Date(BASE - 1000).toISOString() }) }],
    policy,
  );
  assert.equal(metrics.byMode.mock.observationToAcceptanceMs, null);
});

test("no metric claims prevented spend, avoided waste or blocked impressions", () => {
  const source = readFileSync(new URL("./telemetry.ts", import.meta.url), "utf8");
  const metrics = computeMetrics([{ type: "receipt", at: "", receipt: receipt() }], policy);
  for (const forbidden of ["savings", "saved", "wasteAvoided", "spendPrevented", "impressions"]) {
    assert.equal(JSON.stringify(metrics).includes(forbidden), false);
    assert.equal(
      new RegExp(`\\b${forbidden}\\s*[:=]`).test(source),
      false,
      `telemetry must not compute ${forbidden}`,
    );
  }
});

/**
 * The partition exists so that work which never reached a platform cannot be
 * read as work that did. These are the tests that would catch a regression
 * quietly re-merging the buckets.
 */

test("a mixed journal keeps live, dry-run and mock completions apart", () => {
  const metrics = computeMetrics(
    [
      intent("1"),
      intent("2"),
      intent("3"),
      intent("4"),
      { type: "receipt", at: "", receipt: receipt({ executionMode: "live", status: "COMPLETED" }) },
      { type: "receipt", at: "", receipt: receipt({ executionMode: "dry-run", status: "COMPLETED" }) },
      { type: "receipt", at: "", receipt: receipt({ executionMode: "mock", status: "COMPLETED" }) },
      { type: "receipt", at: "", receipt: receipt({ executionMode: "mock", status: "COMPLETED" }) },
    ],
    policy,
  );

  assert.equal(metrics.intents, 4);
  assert.equal(metrics.byMode.live.byStatus.COMPLETED, 1);
  assert.equal(metrics.byMode["dry-run"].byStatus.COMPLETED, 1);
  assert.equal(metrics.byMode.mock.byStatus.COMPLETED, 2);
  assert.equal(metrics.byMode.live.receipts, 1, "three simulated completions must not inflate live");
});

test("simulated latency and SLA attainment never enter the live figures", () => {
  const metrics = computeMetrics(
    [
      // A live submission that missed the SLA.
      {
        type: "receipt",
        at: "",
        receipt: receipt({ executionMode: "live", acceptedAt: new Date(BASE + 400_000).toISOString() }),
      },
      // Instant "acceptances" that never left the process.
      {
        type: "receipt",
        at: "",
        receipt: receipt({ executionMode: "dry-run", acceptedAt: new Date(BASE + 1).toISOString() }),
      },
      {
        type: "receipt",
        at: "",
        receipt: receipt({ executionMode: "mock", acceptedAt: new Date(BASE + 1).toISOString() }),
      },
    ],
    policy,
  );

  assert.deepEqual(metrics.byMode.live.slaAttainment, { within: 0, measured: 1 });
  assert.equal(metrics.byMode.live.observationToAcceptanceMs?.p50, 400_000);
  assert.deepEqual(metrics.byMode["dry-run"].slaAttainment, { within: 1, measured: 1 });
  assert.equal(metrics.byMode.mock.observationToAcceptanceMs?.p50, 1);
});

test("there is no aggregate that could be quoted as a single completion rate", () => {
  const metrics = computeMetrics(
    [{ type: "receipt", at: "", receipt: receipt({ executionMode: "mock" }) }],
    policy,
  );
  const top = metrics as unknown as Record<string, unknown>;
  for (const forbidden of ["byStatus", "receipts", "latencyMs", "slaAttainment"]) {
    assert.equal(forbidden in top, false, `${forbidden} must only exist per mode`);
  }
});

test("a mode with no receipts reports zeros and nulls, not another mode's numbers", () => {
  const metrics = computeMetrics(
    [{ type: "receipt", at: "", receipt: receipt({ executionMode: "mock", status: "COMPLETED" }) }],
    policy,
  );
  assert.equal(metrics.byMode.live.receipts, 0);
  assert.deepEqual(metrics.byMode.live.byStatus, { COMPLETED: 0, PARTIAL: 0, FAILED: 0, SKIPPED: 0 });
  assert.equal(metrics.byMode.live.observationToAcceptanceMs, null);
  assert.equal(metrics.byMode.live.slaAttainment, null);
});

test("mode-independent counts stay at the top level rather than being guessed into a mode", () => {
  const metrics = computeMetrics(
    [
      { type: "transition", at: "", campaignId: "c", claimId: "1", platform: "mock", state: "RETRY_SCHEDULED", attempt: 1 },
      { type: "transition", at: "", campaignId: "c", claimId: "2", platform: "mock", state: "SKIPPED", attempt: 0, skipReason: "NO_CONSENT" },
      { type: "dead-letter", at: "", campaignId: "c", claimId: "3", platform: "mock", code: "X", attempts: 5 },
    ],
    policy,
  );
  assert.equal(metrics.retries, 1);
  assert.equal(metrics.deadLetters, 1);
  assert.deepEqual(metrics.skips, { NO_CONSENT: 1 });
});

test("the signature audit confirms every stored receipt still verifies", async () => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { buildReceiptBody, signReceipt } = await import("./receipt.ts");
  const account = privateKeyToAccount(`0x${"42".repeat(32)}`);
  const signed = await signReceipt(
    buildReceiptBody({
      claim: {
        campaignId: `0x${"ab".repeat(32)}`,
        claimId: "1",
        evidenceHash: `0x${"cd".repeat(32)}`,
        verifiedAtBlock: "55149673",
      },
      platform: "mock",
      executionMode: "mock",
      status: "COMPLETED",
      subjectCommitment: "a".repeat(64),
      conversionRequestId: "k1",
      suppressionRequestId: "k2",
      observedAt: new Date(BASE).toISOString(),
      acceptedAt: new Date(BASE + 1000).toISOString(),
      exclusionConfigurationHash: "e".repeat(64),
      outcomes: [],
      signer: account.address,
    }),
    account,
  );

  const clean = await auditReceipts([{ type: "receipt", at: "", receipt: signed }]);
  assert.deepEqual(clean, { checked: 1, valid: 1, invalid: [] });

  // An altered journal is exactly what this is for.
  const tampered = { ...signed, status: "COMPLETED" as const, acceptedAt: new Date(BASE).toISOString() };
  const dirty = await auditReceipts([{ type: "receipt", at: "", receipt: tampered }]);
  assert.equal(dirty.valid, 0);
  assert.equal(dirty.invalid.length, 1);
  assert.equal(dirty.invalid[0].receiptId, signed.receiptId);
});

test("the audit reports nothing to check on an empty journal", async () => {
  assert.deepEqual(await auditReceipts([]), { checked: 0, valid: 0, invalid: [] });
});
