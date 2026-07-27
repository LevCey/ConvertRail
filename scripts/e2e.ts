// Headless end-to-end run against Arc testnet: starts every component,
// drives the full adversarial loop, and asserts the outcome. Fails loud
// (non-zero exit, named check) if any target is missed within the deadline.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Address } from "viem";
import {
  campaignEscrowAbi,
  campaignIdFromName,
  chainEnvFromProcess,
  conversionRegistryAbi,
  loadDemoConfig,
  loadWallets,
  publicClient,
  REJECT_REASON,
} from "@convertrail/shared";

const TARGET_SETTLED = Number(process.env.E2E_TARGET_SETTLED ?? 20);
const DEADLINE_MS = Number(process.env.E2E_DEADLINE_MS ?? 15 * 60_000);

const config = loadDemoConfig();
const wallets = loadWallets();
const env = chainEnvFromProcess();
const pub = publicClient(env);
const campaignId = campaignIdFromName(config.campaign.name);
const fraudAddress = wallets[config.fraud.id].address.toLowerCase();

rmSync(".e2e", { recursive: true, force: true });
mkdirSync(".e2e", { recursive: true });

const children: ChildProcess[] = [];
function run(name: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn("node", args, { env: { ...process.env, ...extraEnv } });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${name}] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${name}!] ${d}`));
  child.on("exit", (code) => {
    if (code !== null && code !== 0) console.error(`[e2e] ${name} exited with code ${code}`);
  });
  children.push(child);
  return child;
}

function shutdown(): void {
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

run("merchant", ["merchant-sim/src/main.ts"]);
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

run("advertiser", ["agents/src/advertiser.ts"]);
await waitFor("campaign on-chain", async () => {
  await pub.readContract({
    address: env.campaignEscrow,
    abi: campaignEscrowAbi,
    functionName: "getCampaign",
    args: [campaignId],
  });
  return true;
}, 120_000);

run("verifier", ["verifier/src/main.ts"]);
const settlement = run("settlement", ["settlement/src/main.ts"], {
  SETTLEMENT_MAX_RECOGNIZED: String(TARGET_SETTLED),
});
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
    acc.fraudSettled += settledThis.filter(
      (l) => (l.args as { publisher: string }).publisher.toLowerCase() === fraudAddress,
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

const started = Date.now();
let summary: Summary = {
  settled: 0, rejected: 0, disputed: 0, fraudSettled: 0, reallocations: 0,
  duplicateReverts: 0, payments: 0, rejectReasons: {},
};

const ruleFired = (reason: number): boolean => (summary.rejectReasons[reason] ?? 0) > 0;

while (Date.now() - started < DEADLINE_MS) {
  await new Promise((r) => setTimeout(r, 10_000));
  summary = await collect().catch((err) => {
    console.error("[e2e] collect error:", (err as Error).message.split("\n")[0]);
    return summary;
  });
  console.log(
    `[e2e] settled=${summary.settled}/${TARGET_SETTLED} paid=${summary.payments} rejected=${summary.rejected}` +
      ` (evidence=${summary.rejectReasons[REJECT_REASON.EVIDENCE_MISMATCH] ?? 0} timing=${summary.rejectReasons[REJECT_REASON.TIMING_ANOMALY] ?? 0})` +
      ` dupReverts=${summary.duplicateReverts} realloc=${summary.reallocations} fraudSettled=${summary.fraudSettled}`,
  );
  if (
    summary.settled >= TARGET_SETTLED &&
    summary.payments >= TARGET_SETTLED &&
    ruleFired(REJECT_REASON.EVIDENCE_MISMATCH) &&
    ruleFired(REJECT_REASON.TIMING_ANOMALY) &&
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
if (summary.duplicateReverts < 1) failures.push("no on-chain duplicate revert");
if (summary.reallocations < 1) failures.push("no autonomous reallocation");
if (summary.fraudSettled > 0) failures.push(`fraud publisher got ${summary.fraudSettled} settlements`);
failures.push(...(await reconcileWithRetry()));

console.log("\n[e2e] final:", JSON.stringify(summary));
if (failures.length > 0) {
  console.error("[e2e] FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("[e2e] PASSED: full adversarial loop verified on Arc testnet");
process.exit(0);
