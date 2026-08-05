// Runs the suppression module end to end without a chain, without credentials
// and without touching any ad platform: a real merchant endpoint over a local
// socket, the real watcher, runner, store and receipt signing, and a scripted
// stand-in for the platform.
//
// It exists because the module could otherwise only be exercised by its tests.
// This produces an actual journal and actual signed receipts to inspect, and it
// is the artifact behind the claim that the mock slice passes. Every identity
// below is synthetic and unroutable by construction.
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { keccak256, stringToHex } from "viem";
import {
  handleSuppressionSubject,
  type SubjectRecord,
} from "../merchant-sim/src/suppression-endpoint.ts";
import { openEnvelope } from "../suppression/src/envelope.ts";
import { processClaim, type EnvelopeFetch, type RunnerDeps } from "../suppression/src/runner.ts";
import { SuppressionStore } from "../suppression/src/store.ts";
import { SuppressionWatcher, type ChainReader, type ClaimEventLog } from "../suppression/src/watcher.ts";
import { MockSuppressionAdapter, type MockScript } from "../suppression/src/adapters/mock.ts";
import { auditReceipts, computeMetrics } from "../suppression/src/telemetry.ts";
import type { SuppressionPolicy, VerifiedClaim } from "../suppression/src/types.ts";

const ROOT = ".suppression/demo";
const TENANT = "suppression-demo";
const TOKEN = "demo-service-token-not-a-secret-0000000000";
const COMMITMENT_KEY = "demo-commitment-key-not-for-production-0000";

// Fixed so the run is reproducible and so nothing here is mistaken for a key
// that guards anything.
const merchant = privateKeyToAccount(keccak256(stringToHex("suppression-demo:merchant")));
const signer = privateKeyToAccount(keccak256(stringToHex("suppression-demo:receipt-signer")));

const CAMPAIGN = keccak256(stringToHex("suppression-demo-campaign"));

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// --- merchant ---------------------------------------------------------------

/** Conversion times are fixed, not derived from the clock at request time: a
 * merchant's record of when a purchase happened does not change between two
 * reads, and the envelope fingerprint is right to reject one that does. */
const conversions = new Map<string, SubjectRecord>();

function evidenceHashFor(claimId: number): Hex {
  return keccak256(stringToHex(`suppression-demo:evidence:${claimId}`));
}

for (let id = 1; id <= 12; id++) {
  conversions.set(evidenceHashFor(id), {
    conversionId: `c-${id}`,
    conversionTs: Date.parse("2026-08-04T12:00:00.000Z") + id * 60_000,
    order: id % 3 === 0 ? null : { value: `${19 + id}.99`, currency: "USD" },
  });
}

async function startMerchant(): Promise<{ url: string; server: Server }> {
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
      (hash) => conversions.get(hash),
      merchant,
      { token: TOKEN, ttlMs: 300_000, now: Date.now },
    ).then(({ status, body, headers }) => {
      res.statusCode = status;
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("merchant did not bind");
  return { url: `http://127.0.0.1:${address.port}`, server };
}

const { url: merchantUrl, server } = await startMerchant();

/** The same shape the watcher uses: authenticate the merchant's response before
 * anything inside it is trusted. */
function envelopeFetcher(token = TOKEN) {
  return async (claim: VerifiedClaim): Promise<EnvelopeFetch> => {
    let response: Response;
    try {
      response = await fetch(`${merchantUrl}/suppression-subject/${claim.evidenceHash}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      return { ok: false, retryable: true, reason: `ENVELOPE_TRANSPORT:${(error as Error).name}` };
    }
    if (!response.ok) return { ok: false, retryable: false, reason: `ENVELOPE_HTTP_${response.status}` };
    const opened = await openEnvelope(await response.json(), {
      merchant: merchant.address,
      evidenceHash: claim.evidenceHash,
      nowMs: Date.now(),
    });
    return opened.ok
      ? { ok: true, envelope: opened.envelope }
      : { ok: false, retryable: false, reason: `ENVELOPE_REJECTED:${opened.reason}` };
  };
}

// --- scenarios --------------------------------------------------------------

interface Scenario {
  name: string;
  claims: number[];
  script?: MockScript;
  policy?: Partial<SuppressionPolicy>;
  token?: string;
  expect: string;
}

const COMPLETE = { targeted: 2, observed: 2, excluding: 2, unresolved: [] };

const scenarios: Scenario[] = [
  { name: "settled conversions", claims: [1, 2, 3, 4], expect: "COMPLETED" },
  {
    name: "platform hiccup, same key retried",
    claims: [5],
    script: { conversion: ["transient", "transient", "accepted"], coverage: COMPLETE },
    expect: "COMPLETED",
  },
  {
    name: "platform rejects the conversion",
    claims: [6],
    script: { conversion: ["permanent"], coverage: COMPLETE },
    expect: "FAILED",
  },
  {
    name: "audience accepted, one ad set not excluding",
    claims: [7],
    script: { coverage: { targeted: 2, observed: 2, excluding: 1, unresolved: [] } },
    expect: "PARTIAL",
  },
  {
    name: "an ad set we could not read",
    claims: [8],
    script: { coverage: { targeted: 2, observed: 1, excluding: 1, unresolved: ["adset-b"] } },
    expect: "PARTIAL",
  },
  {
    name: "dry run: nothing is sent, so nothing is claimed",
    claims: [9],
    policy: { dryRun: true },
    expect: "PARTIAL",
  },
  {
    name: "merchant refuses the identity",
    claims: [10],
    token: "wrong-token",
    expect: "FAILED",
  },
];

function policyFor(overrides: Partial<SuppressionPolicy> = {}): SuppressionPolicy {
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

function depsFor(store: SuppressionStore, scenario: Scenario) {
  const adapter = new MockSuppressionAdapter(scenario.script ?? { coverage: COMPLETE });
  const deps: RunnerDeps = {
    store,
    adapter,
    policy: policyFor(scenario.policy),
    signer,
    tenantId: TENANT,
    commitmentKey: COMMITMENT_KEY,
    fetchEnvelope: envelopeFetcher(scenario.token),
    now: Date.now,
    sleep: async () => {},
  };
  return { deps, adapter };
}

function claimOf(id: number, block: number): VerifiedClaim {
  return {
    campaignId: CAMPAIGN,
    claimId: String(id),
    evidenceHash: evidenceHashFor(id),
    verifiedAtBlock: String(1000 + block),
  };
}

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

console.log(`suppression demo — mock platform, synthetic buyers, no chain\n`);

const store = new SuppressionStore(ROOT);

for (const scenario of scenarios) {
  const { deps, adapter } = depsFor(store, scenario);
  const statuses: string[] = [];
  for (const id of scenario.claims) {
    const receipt = await processClaim(claimOf(id, id), deps);
    statuses.push(receipt.status);
    check(
      receipt.status === scenario.expect,
      `${scenario.name}: claim ${id} was ${receipt.status}, expected ${scenario.expect}`,
    );
    check(
      receipt.executionMode === "mock",
      `${scenario.name}: claim ${id} signed as ${receipt.executionMode}, not mock`,
    );
  }
  const effects = `${adapter.effectCount("conversion")}c/${adapter.effectCount("audience")}a`;
  console.log(`  ${scenario.name.padEnd(44)} ${statuses.join(",").padEnd(10)} ${effects}`);
}

// --- consent, discovery, recovery and disputes ------------------------------

// A buyer who withheld consent. Nothing is sent and the receipt says why.
{
  const consentClaim = claimOf(11, 11);
  const withheld = conversions.get(consentClaim.evidenceHash);
  if (!withheld) throw new Error("demo: missing conversion record");
  // The synthetic buyer pool withholds consent for a deterministic subset; find
  // one rather than fabricating a special case.
  for (let id = 1; id <= 200; id++) {
    const probe = `c-${id}`;
    const { syntheticBuyer } = await import("../merchant-sim/src/synthetic-identity.ts");
    if (!syntheticBuyer(probe).consentGranted) {
      conversions.set(consentClaim.evidenceHash, { ...withheld, conversionId: probe });
      break;
    }
  }
  const { deps, adapter } = depsFor(store, { name: "consent", claims: [11], expect: "SKIPPED" });
  const receipt = await processClaim(consentClaim, deps);
  console.log(`  ${"buyer withheld consent".padEnd(44)} ${receipt.status.padEnd(10)} ${adapter.calls.length} calls`);
  check(receipt.status === "SKIPPED", `withheld consent produced ${receipt.status}`);
  check(adapter.calls.length === 0, "withheld consent still reached the platform");
}

// Discovery through the watcher, then a restart that must repeat no work.
{
  const discovered: ClaimEventLog[] = [{ claimId: "12", blockNumber: 1012n }];
  // The head starts behind the events and is advanced once the watcher has
  // pinned its cursor, which is how a real run sees them: `start()` trusts the
  // stored cursor or the current head, and only blocks after that are scanned.
  const chain = { head: 1000n };
  const reader: ChainReader = {
    currentBlock: async () => chain.head,
    verifiedIn: async (from, to) =>
      discovered.filter((l) => l.blockNumber >= from && l.blockNumber <= to),
    disputedIn: async (from, to) =>
      from <= 1050n && to >= 1050n ? [{ claimId: "12", blockNumber: 1050n }] : [],
    claimEvidence: async (claimId) => ({
      campaignId: CAMPAIGN,
      evidenceHash: evidenceHashFor(Number(claimId)),
    }),
  };

  const { deps, adapter } = depsFor(store, { name: "watcher", claims: [12], expect: "COMPLETED" });
  const watcher = new SuppressionWatcher({
    store,
    reader,
    campaignId: CAMPAIGN,
    platform: "mock",
    process: (claim) => processClaim(claim, deps),
  });
  await watcher.start();
  chain.head = 1100n;
  const first = await watcher.poll();
  await watcher.idle();
  console.log(
    `  ${"watcher discovery".padEnd(44)} ${String(first.discovered).padEnd(10)} ` +
      `${adapter.effectCount("conversion")}c/${adapter.effectCount("audience")}a`,
  );
  check(first.discovered === 1, `watcher discovered ${first.discovered} claims, expected 1`);
  check(first.amended === 1, "the dispute was not recorded as an amendment");

  // Restart: the journal already holds a signed receipt, so nothing runs again.
  const restarted = depsFor(new SuppressionStore(ROOT), { name: "restart", claims: [12], expect: "COMPLETED" });
  const replayed = new SuppressionWatcher({
    store: restarted.deps.store,
    reader,
    campaignId: CAMPAIGN,
    platform: "mock",
    process: (claim) => processClaim(claim, restarted.deps),
  });
  const recovered = replayed.resume();
  await replayed.idle();
  console.log(`  ${"restart and replay".padEnd(44)} ${String(recovered).padEnd(10)} ${restarted.adapter.calls.length} calls`);
  check(restarted.adapter.calls.length === 0, "a restart repeated platform work");
}

// --- what the journal says --------------------------------------------------

const replayStore = new SuppressionStore(ROOT);
const records = replayStore.records();
const metrics = computeMetrics(records, policyFor());
const audit = await auditReceipts(records);

console.log(`\njournal: ${records.length} records, ${metrics.intents} claims taken on`);
for (const [mode, bucket] of Object.entries(metrics.byMode)) {
  if (bucket.receipts === 0) continue;
  const s = bucket.byStatus;
  console.log(
    `  ${mode.padEnd(9)} ${bucket.receipts} receipts  ` +
      `completed ${s.COMPLETED} partial ${s.PARTIAL} failed ${s.FAILED} skipped ${s.SKIPPED}` +
      (bucket.slaAttainment
        ? `  within SLA ${bucket.slaAttainment.within}/${bucket.slaAttainment.measured}`
        : ""),
  );
}
console.log(
  `  retries ${metrics.retries}  dead letters ${metrics.deadLetters}  amendments ${metrics.amendments}`,
);
console.log(`  signatures: ${audit.valid}/${audit.checked} verify against the signer each names`);

// --- invariants -------------------------------------------------------------

const journal = readFileSync(`${ROOT}/journal.jsonl`, "utf8");
const { syntheticBuyer } = await import("../merchant-sim/src/synthetic-identity.ts");
for (const record of conversions.values()) {
  const buyer = syntheticBuyer(record.conversionId);
  check(!journal.includes(buyer.email), `an email reached the journal (${record.conversionId})`);
  check(!journal.includes(buyer.phone), `a phone reached the journal (${record.conversionId})`);
  check(!journal.includes(buyer.subjectRef), `a subject reference reached the journal`);
}
check(!/[^\s@"]+@[^\s@"]+\.[^\s@"]+/.test(journal), "something email-shaped reached the journal");
check(audit.valid === audit.checked, `${audit.checked - audit.valid} receipts failed verification`);
check(metrics.byMode.live.receipts === 0, "a mock run produced a live receipt");
check(
  metrics.byMode.mock.byStatus.COMPLETED > 0 && metrics.byMode.mock.byStatus.PARTIAL > 0,
  "the run did not exercise both completion and partial outcomes",
);

server.close();

if (failures.length > 0) {
  console.error(`\nFAILED — ${failures.length} invariant(s) broken:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`\nclean: no identifier in the journal, every receipt verifies, nothing signed as live.`);
console.log(`journal at ${ROOT}/journal.jsonl — verify it with:`);
console.log(`  npm run suppression:verify -- ${ROOT}/journal.jsonl`);
