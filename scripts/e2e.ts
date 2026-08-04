// Headless end-to-end run against Arc testnet: starts every component,
// drives the full adversarial loop, and asserts the outcome. Fails loud
// (non-zero exit, named check) if any target is missed within the deadline.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseAbiItem, type Address } from "viem";
import {
  campaignEscrowAbi,
  campaignIdFromName,
  chainEnvFromProcess,
  conversionRegistryAbi,
  loadDemoConfig,
  loadWallets,
  publicClient,
  REJECT_REASON,
  evaluateRunHealth,
  type ClaimEvent,
} from "@convertrail/shared";

const TARGET_SETTLED = Number(process.env.E2E_TARGET_SETTLED ?? 20);
const DEADLINE_MS = Number(process.env.E2E_DEADLINE_MS ?? 15 * 60_000);

const config = loadDemoConfig();
const wallets = loadWallets();
const env = chainEnvFromProcess();
const pub = publicClient(env);
const campaignId = campaignIdFromName(config.campaign.name);
const NATIVE_TRANSFER_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe" as Address;
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
// Both identities the fraud agent operates. The second one exists precisely to
// look like someone else, so the "nothing was paid to the attacker" gate has to
// cover it — otherwise the one attack designed to evade attribution would also
// evade the assertion.
const fraudAddresses = new Set(
  [config.fraud.id, ...(config.fraud.sybil ? [config.fraud.sybil.id] : [])].map((id) =>
    wallets[id].address.toLowerCase(),
  ),
);

// Atomic single-run lock. Two harnesses racing for the same merchant port and
// campaign produce a run whose numbers look real and are not — the failure that
// invalidated poc-demo-13. `wx` makes the check and the claim one operation, so
// two simultaneous starts cannot both win. The lock lives outside `.e2e/`
// because that directory is wiped a few lines below.
const LOCK_PATH = ".e2e.lock";
function claimRunLock(): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK_PATH, `${process.pid}\n`, { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number(readFileSync(LOCK_PATH, "utf8").trim());
      let alive = false;
      try {
        process.kill(holder, 0); // signal 0 tests for existence only
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) {
        console.error(
          `[e2e] FAILED: another run is already in progress (pid ${holder}). ` +
            `Concurrent runs share the merchant port and campaign and cannot both be valid.`,
        );
        process.exit(1);
      }
      console.error(`[e2e] clearing stale lock from dead pid ${holder}`);
      rmSync(LOCK_PATH, { force: true });
    }
  }
  console.error("[e2e] FAILED: could not claim the run lock");
  process.exit(1);
}
claimRunLock();
process.on("exit", () => rmSync(LOCK_PATH, { force: true }));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    rmSync(LOCK_PATH, { force: true });
    process.exit(1);
  });
}

rmSync(".e2e", { recursive: true, force: true });
mkdirSync(".e2e", { recursive: true });

const children: ChildProcess[] = [];
let stopping = false;

/**
 * @param critical a component the run is meaningless without. Its death is
 *   fatal, not a log line: a merchant source that cannot bind its port leaves
 *   the publishers reading whatever else is on it, which is how a run once
 *   completed against a stale process and produced numbers that looked real.
 *   Logging and continuing is not an option — a contaminated run that reports
 *   PASSED is worse than no run.
 */
function run(
  name: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  critical = false,
): ChildProcess {
  const child = spawn("node", args, { env: { ...process.env, ...extraEnv } });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${name}] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${name}!] ${d}`));
  child.on("exit", (code) => {
    if (stopping || code === null || code === 0) return;
    console.error(`[e2e] ${name} exited with code ${code}`);
    if (critical) {
      console.error(`[e2e] FAILED: ${name} is required for a valid run — aborting rather than measuring a contaminated one`);
      shutdown();
      process.exit(1);
    }
  });
  children.push(child);
  return child;
}

function shutdown(): void {
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}

/** Thrown by a readiness check that has established the condition can never
 * be met — waiting longer would only delay the same failure. Ordinary errors
 * mean "not yet" (a contract read reverts until the campaign exists, a fetch
 * fails until the port is up) and are retried until the timeout. */
class Unmeetable extends Error {}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let ready = false;
    try {
      ready = await check();
    } catch (err) {
      if (err instanceof Unmeetable) {
        shutdown();
        throw new Error(`e2e: ${label} — ${err.message}`);
      }
      ready = false; // not ready yet; keep waiting
    }
    if (ready) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  shutdown();
  throw new Error(`e2e: timed out waiting for ${label}`);
}

const startBlock = await pub.getBlockNumber();
writeFileSync(
  ".e2e/run.json",
  JSON.stringify({ campaignId, campaignName: config.campaign.name, startBlock: startBlock.toString() }, null, 2) + "\n",
);
console.log(`[e2e] starting from block ${startBlock}, target ${TARGET_SETTLED} settled claims`);

run("merchant", ["merchant-sim/src/main.ts"], {}, true);
// Insist the merchant source on that port is *this* run's. A leftover process
// from an earlier run answers happily and serves another campaign's events,
// which produces a full run of claims refused for evidence that was never
// theirs — a failure that looks like a broken verifier and is not one.
await waitFor("merchant-sim serving this campaign", async () => {
  // Still starting up is not an error; answering for the wrong campaign is.
  const res = await fetch(`http://localhost:${config.merchantSim.port}/health`).catch(() => null);
  if (!res?.ok) return false;
  const health = (await res.json()) as { campaignId?: string; campaignName?: string };
  if (health.campaignId === campaignId) return true;
  throw new Unmeetable(
    `port ${config.merchantSim.port} is held by a merchant source for campaign ` +
      `"${health.campaignName ?? "unknown"}" (${health.campaignId}), not "${config.campaign.name}" ` +
      `(${campaignId}). Stop that process and re-run.`,
  );
}, 30_000);

run("advertiser", ["agents/src/advertiser.ts"], {}, true);
await waitFor("campaign on-chain", async () => {
  await pub.readContract({
    address: env.campaignEscrow,
    abi: campaignEscrowAbi,
    functionName: "getCampaign",
    args: [campaignId],
  });
  return true;
}, 120_000);

run("verifier", ["verifier/src/main.ts"], {}, true);
const settlement = run("settlement", ["settlement/src/main.ts"], {
  SETTLEMENT_MAX_RECOGNIZED: String(TARGET_SETTLED),
}, true);
run("pub-a", ["agents/src/publisher.ts", "pub-a"]);
run("pub-b", ["agents/src/publisher.ts", "pub-b"]);
run("fraud", ["agents/src/fraud.ts"]);

interface Summary {
  settled: number;
  rejected: number;
  disputed: number;
  fraudSettled: number;
  reallocations: number;
  duplicateReverts: number;
  payments: number;
  /** Rejections by on-chain reason code, so the gate can prove each
   * deterministic rule actually fired rather than just counting refusals. */
  rejectReasons: Record<number, number>;
}

// Incremental, rate-limit-resilient collection: only the un-scanned block
// tail is queried each cycle, and the cursor advances only after a fully
// successful scan — so a throttled cycle drops nothing, it just retries the
// same (small) range next time. Counts are cumulative accumulators.
const acc = {
  settled: 0, rejected: 0, disputed: 0, fraudSettled: 0, reallocations: 0,
  rejectReasons: {} as Record<number, number>,
};
let collectedThrough = startBlock - 1n;

async function collect(): Promise<Summary> {
  const current = await pub.getBlockNumber();
  if (current > collectedThrough) {
    const fromBlock = collectedThrough + 1n;
    const [settledLogs, rejectedLogs, disputedLogs, reallocLogs] = await Promise.all([
      pub.getContractEvents({
        address: env.conversionRegistry, abi: conversionRegistryAbi, eventName: "ClaimSettled",
        fromBlock, toBlock: current,
      }),
      pub.getContractEvents({
        address: env.conversionRegistry, abi: conversionRegistryAbi, eventName: "ClaimRejected",
        fromBlock, toBlock: current,
      }),
      pub.getContractEvents({
        address: env.conversionRegistry, abi: conversionRegistryAbi, eventName: "ClaimDisputed",
        fromBlock, toBlock: current,
      }),
      pub.getContractEvents({
        address: env.campaignEscrow, abi: campaignEscrowAbi, eventName: "BudgetReallocated",
        fromBlock, toBlock: current,
      }),
    ]);
    const inCampaign = (l: { args: unknown }) =>
      (l.args as { campaignId: `0x${string}` }).campaignId === campaignId;
    const settledThis = settledLogs.filter(inCampaign);
    acc.settled += settledThis.length;
    acc.fraudSettled += settledThis.filter((l) =>
      fraudAddresses.has((l.args as { publisher: string }).publisher.toLowerCase()),
    ).length;
    const rejectedThis = rejectedLogs.filter(inCampaign);
    acc.rejected += rejectedThis.length;
    for (const log of rejectedThis) {
      const reason = Number((log.args as { reason: number }).reason);
      acc.rejectReasons[reason] = (acc.rejectReasons[reason] ?? 0) + 1;
    }
    acc.disputed += disputedLogs.filter(inCampaign).length;
    acc.reallocations += reallocLogs.filter(inCampaign).length;
    collectedThrough = current; // advance only after all four queries succeeded
  }

  const fraudLog = existsSync(".e2e/fraud.jsonl")
    ? readFileSync(".e2e/fraud.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const payments = existsSync(".e2e/payments.jsonl")
    ? readFileSync(".e2e/payments.jsonl", "utf8").trim().split("\n").filter(Boolean).length
    : 0;

  return {
    settled: acc.settled,
    rejected: acc.rejected,
    disputed: acc.disputed,
    fraudSettled: acc.fraudSettled,
    reallocations: acc.reallocations,
    duplicateReverts: fraudLog.filter((e) => e.type === "duplicate" && e.status === "reverted").length,
    payments,
    rejectReasons: { ...acc.rejectReasons },
  };
}

// R7 acceptance (2.8): after the run, escrow accounting must equal the sum of
// recognized payouts. Reconciles three independent views — the escrow's own
// recognizedTotal, the sum of PayoutRecognized events, and the settlement
// module's payment log — plus each publisher's allocation.recognized against
// its share of the events. Any divergence is a hard failure.
async function reconcile(): Promise<string[]> {
  const errs: string[] = [];
  const current = await pub.getBlockNumber();

  const recognizedLogs = (
    await pub.getContractEvents({
      address: env.campaignEscrow,
      abi: campaignEscrowAbi,
      eventName: "PayoutRecognized",
      fromBlock: startBlock,
      toBlock: current,
    })
  ).filter((l) => (l.args as { campaignId: `0x${string}` }).campaignId === campaignId);

  const recognizedFromEvents = recognizedLogs.reduce(
    (sum, l) => sum + (l.args as { amount: bigint }).amount,
    0n,
  );

  const campaign = await pub.readContract({
    address: env.campaignEscrow,
    abi: campaignEscrowAbi,
    functionName: "getCampaign",
    args: [campaignId],
  });
  if (campaign.recognizedTotal !== recognizedFromEvents) {
    errs.push(`escrow recognizedTotal ${campaign.recognizedTotal} != sum(PayoutRecognized) ${recognizedFromEvents}`);
  }

  const paidTotal = existsSync(".e2e/payments.jsonl")
    ? readFileSync(".e2e/payments.jsonl", "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .reduce((sum, line) => sum + BigInt((JSON.parse(line) as { amount: string }).amount), 0n)
    : 0n;
  if (paidTotal !== recognizedFromEvents) {
    errs.push(`sum(payments) ${paidTotal} != escrow recognized ${recognizedFromEvents}`);
  }

  const perPublisher = new Map<string, bigint>();
  for (const l of recognizedLogs) {
    const a = l.args as { publisher: string; amount: bigint };
    const key = a.publisher.toLowerCase();
    perPublisher.set(key, (perPublisher.get(key) ?? 0n) + a.amount);
  }
  for (const [publisher, recognized] of perPublisher) {
    const alloc = await pub.readContract({
      address: env.campaignEscrow,
      abi: campaignEscrowAbi,
      functionName: "getAllocation",
      args: [campaignId, publisher as Address],
    });
    if (alloc.recognized !== recognized) {
      errs.push(`allocation.recognized ${alloc.recognized} != sum(PayoutRecognized[${publisher.slice(0, 10)}]) ${recognized}`);
    }
  }
  return errs;
}

async function reconcileWithRetry(): Promise<string[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await reconcile();
    } catch (err) {
      if (attempt >= 5) return [`reconcile failed after retries: ${(err as Error).message.split("\n")[0]}`];
      await new Promise((r) => setTimeout(r, 3_000 * attempt));
    }
  }
}

// Counted and reported separately from component failures. A throttle the
// harness's own collector absorbs by re-reading the same block range is not
// the same event as a component loop exhausting its retries, and reporting
// them as one number would overstate how clean a run was.
let harnessTransientErrors = 0;

const started = Date.now();
let summary: Summary = {
  settled: 0, rejected: 0, disputed: 0, fraudSettled: 0, reallocations: 0,
  duplicateReverts: 0, payments: 0, rejectReasons: {},
};

const ruleFired = (reason: number): boolean => (summary.rejectReasons[reason] ?? 0) > 0;

while (Date.now() - started < DEADLINE_MS) {
  await new Promise((r) => setTimeout(r, 10_000));
  summary = await collect().catch((err) => {
    harnessTransientErrors++;
    console.error("[e2e] collect error (harness-transient, cursor retries):", (err as Error).message.split("\n")[0]);
    return summary;
  });
  console.log(
    `[e2e] settled=${summary.settled}/${TARGET_SETTLED} paid=${summary.payments} rejected=${summary.rejected}` +
      ` (evidence=${summary.rejectReasons[REJECT_REASON.EVIDENCE_MISMATCH] ?? 0}` +
      ` timing=${summary.rejectReasons[REJECT_REASON.TIMING_ANOMALY] ?? 0}` +
      ` linked=${summary.rejectReasons[REJECT_REASON.LINKED_PUBLISHER] ?? 0})` +
      ` dupReverts=${summary.duplicateReverts} realloc=${summary.reallocations} fraudSettled=${summary.fraudSettled}`,
  );
  if (
    summary.settled >= TARGET_SETTLED &&
    summary.payments >= TARGET_SETTLED &&
    ruleFired(REJECT_REASON.EVIDENCE_MISMATCH) &&
    ruleFired(REJECT_REASON.TIMING_ANOMALY) &&
    ruleFired(REJECT_REASON.LINKED_PUBLISHER) &&
    summary.duplicateReverts >= 1 &&
    summary.reallocations >= 1
  ) {
    break;
  }
}

// Graceful drain before reconciling: stop every producer, then give the
// settlement module time to pay any claim it has recognized-but-not-yet-paid.
// autoSettle (recognition) and the payout are separate txs; an abrupt kill
// between them would leave escrow.recognizedTotal one claim ahead of the
// payments log — a teardown artifact, not an accounting fault.
for (const child of children) {
  if (child !== settlement) child.kill("SIGTERM");
}
const paidTotal = (): bigint =>
  existsSync(".e2e/payments.jsonl")
    ? readFileSync(".e2e/payments.jsonl", "utf8").trim().split("\n").filter(Boolean)
        .reduce((s, l) => s + BigInt((JSON.parse(l) as { amount: string }).amount), 0n)
    : 0n;
const drainStart = Date.now();
while (Date.now() - drainStart < 60_000) {
  await new Promise((r) => setTimeout(r, 3_000));
  const campaign = await pub
    .readContract({ address: env.campaignEscrow, abi: campaignEscrowAbi, functionName: "getCampaign", args: [campaignId] })
    .catch(() => null);
  if (campaign && campaign.recognizedTotal === paidTotal()) break;
}
settlement.kill("SIGTERM");
summary = await collect().catch(() => summary);

const failures: string[] = [];
if (summary.settled < TARGET_SETTLED) failures.push(`settled ${summary.settled} < ${TARGET_SETTLED}`);
if (summary.payments < summary.settled) failures.push(`payments ${summary.payments} < settled ${summary.settled}`);
// Each deterministic rule must have refused something on-chain: a run where
// only one of them fires does not demonstrate the verification layer it claims.
if (!ruleFired(REJECT_REASON.EVIDENCE_MISMATCH)) failures.push("no fabricated-claim rejection (EVIDENCE_MISMATCH)");
if (!ruleFired(REJECT_REASON.TIMING_ANOMALY)) failures.push("no bot-traffic rejection (TIMING_ANOMALY)");
if (config.fraud.sybil && !ruleFired(REJECT_REASON.LINKED_PUBLISHER)) {
  failures.push("no linked-identity rejection (LINKED_PUBLISHER)");
}
if (summary.duplicateReverts < 1) failures.push("no on-chain duplicate revert");
if (summary.reallocations < 1) failures.push("no autonomous reallocation");
if (summary.fraudSettled > 0) failures.push(`fraud publisher got ${summary.fraudSettled} settlements`);
// Emitter self-check. The funding graph is built from Transfer logs emitted by
// a synthetic address rather than from full blocks, which is far cheaper and
// excludes reverted transfers — but it rests on undocumented node behaviour.
// One assertion per run keeps that dependency honest: the fraud agent's own
// funding transaction must appear in those logs with matching parties and
// value, or the evidence behind every LINKED_PUBLISHER refusal is unsound.
if (config.fraud.sybil && existsSync(".e2e/fraud.jsonl")) {
  const funding = readFileSync(".e2e/fraud.jsonl", "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; txHash?: `0x${string}` })
    .find((r) => r.type === "sybil_funding");
  if (!funding?.txHash) {
    failures.push("emitter self-check: no sybil_funding transaction was recorded this run");
  } else {
    try {
      const tx = await pub.getTransaction({ hash: funding.txHash });
      const logs = await pub.getLogs({
        address: NATIVE_TRANSFER_EMITTER,
        event: transferEvent,
        fromBlock: tx.blockNumber!,
        toBlock: tx.blockNumber!,
      });
      const match = logs.find(
        (l) =>
          l.transactionHash === funding.txHash &&
          l.args.from?.toLowerCase() === tx.from.toLowerCase() &&
          l.args.to?.toLowerCase() === (tx.to ?? "").toLowerCase() &&
          l.args.value === tx.value,
      );
      if (!match) {
        failures.push(
          `emitter self-check: ${funding.txHash} moved ${tx.value} from ${tx.from} to ${tx.to} ` +
            `but no matching Transfer log was emitted by ${NATIVE_TRANSFER_EMITTER} — ` +
            `the funding index would have missed it`,
        );
      }
    } catch (err) {
      failures.push(`emitter self-check failed to run: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

// No claim may carry two verdicts and no claim may be paid twice. The verdict
// pipeline keeps several sends outstanding, so this is the specific corruption
// that a resend-on-timeout policy would have introduced — asserted rather than
// assumed absent.
if (existsSync(".e2e/payments.jsonl")) {
  const rows = readFileSync(".e2e/payments.jsonl", "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as { claimId?: string | number; reference?: string });
  const byClaim = new Map<string, number>();
  const byRef = new Map<string, number>();
  for (const r of rows) {
    if (r.claimId !== undefined) byClaim.set(String(r.claimId), (byClaim.get(String(r.claimId)) ?? 0) + 1);
    if (r.reference) byRef.set(r.reference, (byRef.get(r.reference) ?? 0) + 1);
  }
  const dupClaims = [...byClaim.entries()].filter(([, n]) => n > 1);
  const dupRefs = [...byRef.entries()].filter(([, n]) => n > 1);
  if (dupClaims.length > 0) failures.push(`duplicate payments for claims: ${dupClaims.map(([c, n]) => `${c}x${n}`).join(", ")}`);
  if (dupRefs.length > 0) failures.push(`duplicate payment references: ${dupRefs.map(([r, n]) => `${r}x${n}`).join(", ")}`);
}
// One post-run scan rather than extra event queries on every collect cycle: the
// duplicate check and the health evaluation need the same three event sets, and
// the run is already competing for this RPC's request budget.
let perf = "";
try {
  const head = await pub.getBlockNumber();
  const evts = async (eventName: string) =>
    (await pub.getContractEvents({
      address: env.conversionRegistry, abi: conversionRegistryAbi, eventName,
      fromBlock: startBlock, toBlock: head,
    })).filter((l) => (l.args as { campaignId?: `0x${string}` }).campaignId === campaignId);
  const [submitted, verified, rejected] = await Promise.all([
    evts("ClaimSubmitted"), evts("ClaimVerified"), evts("ClaimRejected"),
  ]);

  const asEvents = (logs: typeof submitted): ClaimEvent[] =>
    logs.map((l) => ({
      claimId: String((l.args as { claimId?: bigint }).claimId),
      block: Number(l.blockNumber),
    }));
  const verdictEvents = asEvents([...verified, ...rejected] as typeof submitted);

  // Duplicate verdicts stay a correctness gate of their own. Run health
  // deliberately does not look at them: folding the two together is what
  // produced a throughput assertion no correct run could satisfy.
  const counts = new Map<string, number>();
  for (const v of verdictEvents) counts.set(v.claimId, (counts.get(v.claimId) ?? 0) + 1);
  const dup = [...counts.entries()].filter(([, n]) => n > 1);
  if (dup.length > 0) {
    failures.push(`duplicate verdicts for claims: ${dup.map(([c, n]) => `${c}x${n}`).join(", ")}`);
  }

  const health = evaluateRunHealth(asEvents(submitted), verdictEvents);
  failures.push(...health.failures);
  perf =
    `  arrival ${health.arrivalRate.toFixed(3)}/s | verdict ${health.verdictRate.toFixed(3)}/s | ` +
    `completion ${(health.completionRatio * 100).toFixed(1)}%  [telemetry, not a gate]\n` +
    `  backlog by quarter: ${health.backlogByQuarter.join(" -> ")}  (gate: Q4 <= Q3)\n` +
    `  final backlog: ${health.finalBacklog}\n` +
    (health.lag
      ? `  verdict lag blocks: first ${health.lag.first} | median ${health.lag.median} | final ${health.lag.final}\n`
      : "") +
    `  claims submitted ${health.submitted} | verdicts ${health.verdicts} | span ${Math.round(health.spanSeconds)}s`;
} catch (err) {
  failures.push(`post-run health scan failed: ${(err as Error).message.split("\n")[0]}`);
}

failures.push(...(await reconcileWithRetry()));

console.log("\n[e2e] final:", JSON.stringify(summary));
console.log(`[e2e] harness-transient errors (collector throttles, cursor-recovered): ${harnessTransientErrors}`);
if (perf) console.log("[e2e] throughput:\n" + perf);
if (existsSync(".e2e/verifier-stats.json")) {
  console.log("[e2e] verdict pipeline: " + readFileSync(".e2e/verifier-stats.json", "utf8").trim().replace(/\s+/g, " "));
}
if (failures.length > 0) {
  console.error("[e2e] FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("[e2e] PASSED: full adversarial loop verified on Arc testnet");
process.exit(0);
