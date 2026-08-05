import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  handleSuppressionSubject,
  type SubjectRecord,
} from "../../merchant-sim/src/suppression-endpoint.ts";
import { syntheticBuyer } from "../../merchant-sim/src/synthetic-identity.ts";
import { openEnvelope } from "./envelope.ts";
import { processClaim, type EnvelopeFetch, type RunnerDeps } from "./runner.ts";
import { verifyReceipt } from "./receipt.ts";
import { SuppressionStore } from "./store.ts";
import { computeMetrics } from "./telemetry.ts";
import { MockSuppressionAdapter } from "./adapters/mock.ts";
import type { SuppressionPolicy, VerifiedClaim } from "./types.ts";

/**
 * The Phase 3 ↔ 4 seam over a real socket: the merchant releases an envelope,
 * the watcher authenticates it, and the runner drives it to a signed receipt.
 * Every piece below is the production code path except the ad platform and the
 * chain.
 */

const merchant = privateKeyToAccount(`0x${"51".repeat(32)}`);
const signer = privateKeyToAccount(`0x${"42".repeat(32)}`);
const TOKEN = "s".repeat(40);

const claim: VerifiedClaim = {
  campaignId: `0x${"ab".repeat(32)}`,
  claimId: "7",
  evidenceHash: `0x${"cd".repeat(32)}`,
  verifiedAtBlock: "55149673",
};

const record: SubjectRecord = {
  conversionId: "c-42",
  conversionTs: Date.now() - 60_000,
  order: { value: "49.99", currency: "USD" },
};

const cleanups: Array<() => void> = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

async function startMerchant(token = TOKEN): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    const match = url.pathname.match(/^\/suppression-subject\/(0x[0-9a-fA-F]{64})$/);
    if (!match) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    void handleSuppressionSubject(
      match[1] as Hex,
      req.headers.authorization,
      (hash) => (hash === claim.evidenceHash ? record : undefined),
      merchant,
      { token, ttlMs: 300_000, now: Date.now },
    ).then(({ status, body, headers }) => {
      res.statusCode = status;
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}`, server };
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "convertrail-suppression-e2e-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const policy: SuppressionPolicy = {
  platform: "mock",
  trigger: "VERIFIED",
  enabled: true,
  dryRun: false,
  maxAttempts: 5,
  slaSeconds: 300,
};

/** The same shape the watcher uses: authenticate the merchant's response before
 * anything inside it is trusted. */
function envelopeFetcher(baseUrl: string, token: string) {
  return async (target: VerifiedClaim): Promise<EnvelopeFetch> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/suppression-subject/${target.evidenceHash}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      return { ok: false, retryable: true, reason: `ENVELOPE_TRANSPORT:${(error as Error).name}` };
    }
    if (response.status === 429 || response.status >= 500) {
      return { ok: false, retryable: true, reason: `ENVELOPE_HTTP_${response.status}` };
    }
    if (!response.ok) return { ok: false, retryable: false, reason: `ENVELOPE_HTTP_${response.status}` };

    const opened = await openEnvelope(await response.json(), {
      merchant: merchant.address,
      evidenceHash: target.evidenceHash,
      nowMs: Date.now(),
    });
    if (!opened.ok) return { ok: false, retryable: false, reason: `ENVELOPE_REJECTED:${opened.reason}` };
    return { ok: true, envelope: opened.envelope };
  };
}

function deps(baseUrl: string, dir: string, token = TOKEN): RunnerDeps & { adapter: MockSuppressionAdapter } {
  const adapter = new MockSuppressionAdapter();
  return {
    store: new SuppressionStore(dir),
    adapter,
    policy,
    signer,
    tenantId: "poc-demo-suppression",
    commitmentKey: "c".repeat(48),
    fetchEnvelope: envelopeFetcher(baseUrl, token),
    now: Date.now,
    sleep: async () => {},
  };
}

test("a verified claim travels from the merchant endpoint to a signed receipt", async () => {
  const { url } = await startMerchant();
  const dir = freshDir();
  const d = deps(url, dir);

  const receipt = await processClaim(claim, d);
  assert.equal(receipt.status, "COMPLETED");
  assert.equal((await verifyReceipt(receipt)).valid, true);
  assert.equal(d.adapter.effectCount("conversion"), 1);
  assert.equal(d.adapter.effectCount("audience"), 1);
  assert.equal(receipt.verifiedAtBlock, claim.verifiedAtBlock);
});

test("the identifiers the merchant released reach the adapter but never the journal", async () => {
  const { url } = await startMerchant();
  const dir = freshDir();
  const d = deps(url, dir);
  await processClaim(claim, d);

  const buyer = syntheticBuyer(record.conversionId);
  const journal = readFileSync(join(dir, "journal.jsonl"), "utf8");
  assert.equal(journal.includes(buyer.email), false);
  assert.equal(journal.includes(buyer.phone), false);
  assert.equal(journal.includes(buyer.subjectRef), false);
  assert.equal(/[0-9a-f]{64}/.test(journal), true, "digests are expected to be present");

  // The adapter did receive real platform identifiers — the pipeline is not
  // passing empty values and quietly reporting success.
  const call = d.adapter.calls.find((c) => c.action === "conversion");
  assert.deepEqual(call?.subjectKinds, ["em", "external_id", "ph"]);
});

test("a watcher presenting the wrong token gets no identity and records a permanent failure", async () => {
  const { url } = await startMerchant();
  const dir = freshDir();
  const d = deps(url, dir, "wrong-token");

  const receipt = await processClaim(claim, d);
  assert.equal(receipt.status, "FAILED");
  assert.equal(d.adapter.calls.length, 0);
  assert.equal((await verifyReceipt(receipt)).valid, true);
  assert.equal(
    readFileSync(join(dir, "journal.jsonl"), "utf8").includes("ENVELOPE_HTTP_401"),
    true,
  );
});

test("an envelope signed by the wrong merchant is refused before any platform call", async () => {
  const { url } = await startMerchant();
  const dir = freshDir();
  const d = deps(url, dir);
  const impostor = privateKeyToAccount(`0x${"52".repeat(32)}`);
  d.fetchEnvelope = async (target) => {
    const response = await fetch(`${url}/suppression-subject/${target.evidenceHash}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const opened = await openEnvelope(await response.json(), {
      merchant: impostor.address,
      evidenceHash: target.evidenceHash,
      nowMs: Date.now(),
    });
    return opened.ok
      ? { ok: true, envelope: opened.envelope }
      : { ok: false, retryable: false, reason: `ENVELOPE_REJECTED:${opened.reason}` };
  };

  const receipt = await processClaim(claim, d);
  assert.equal(receipt.status, "FAILED");
  assert.equal(d.adapter.calls.length, 0);
});

test("an unknown claim yields nothing rather than someone else's identity", async () => {
  const { url } = await startMerchant();
  const dir = freshDir();
  const d = deps(url, dir);
  const stranger: VerifiedClaim = { ...claim, claimId: "9", evidenceHash: `0x${"11".repeat(32)}` };

  const receipt = await processClaim(stranger, d);
  assert.equal(receipt.status, "FAILED");
  assert.equal(d.adapter.calls.length, 0);
});

test("telemetry replayed from the journal matches what the run actually did", async () => {
  const { url } = await startMerchant();
  const dir = freshDir();
  await processClaim(claim, deps(url, dir));

  // A second process reading only the journal, with no memory of the run.
  const metrics = computeMetrics(new SuppressionStore(dir).records(), policy);
  assert.equal(metrics.intents, 1);
  assert.equal(metrics.byMode.mock.receipts, 1);
  assert.equal(metrics.byMode.mock.byStatus.COMPLETED, 1);
  assert.equal(metrics.deadLetters, 0);
  assert.equal(metrics.byMode.mock.observationToAcceptanceMs?.count, 1);
  assert.equal(metrics.byMode.mock.slaAttainment?.within, 1);
  assert.deepEqual(metrics.exclusionCoverage, { targeted: 2, observed: 2, excluding: 2, unresolved: [] });
});

test("a restarted watcher re-reading the journal repeats no platform work", async () => {
  const { url } = await startMerchant();
  const dir = freshDir();
  const first = deps(url, dir);
  const receipt = await processClaim(claim, first);

  const second = deps(url, dir);
  const replayed = await processClaim(claim, second);
  assert.equal(second.adapter.calls.length, 0);
  assert.deepEqual(replayed, receipt);
});
