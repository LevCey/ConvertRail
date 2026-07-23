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

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check().catch(() => false)) return;
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
await waitFor("merchant-sim port", async () => {
  const res = await fetch(`http://localhost:${config.merchantSim.port}/events?sinceSeq=0`);
  return res.ok;
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
}

// Incremental, rate-limit-resilient collection: only the un-scanned block
// tail is queried each cycle, and the cursor advances only after a fully
// successful scan — so a throttled cycle drops nothing, it just retries the
// same (small) range next time. Counts are cumulative accumulators.
const acc = { settled: 0, rejected: 0, disputed: 0, fraudSettled: 0, reallocations: 0 };
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
    acc.rejected += rejectedLogs.filter(inCampaign).length;
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
let summary: Summary = { settled: 0, rejected: 0, disputed: 0, fraudSettled: 0, reallocations: 0, duplicateReverts: 0, payments: 0 };

while (Date.now() - started < DEADLINE_MS) {
  await new Promise((r) => setTimeout(r, 10_000));
  summary = await collect().catch((err) => {
    console.error("[e2e] collect error:", (err as Error).message.split("\n")[0]);
    return summary;
  });
  console.log(
    `[e2e] settled=${summary.settled}/${TARGET_SETTLED} paid=${summary.payments} rejected=${summary.rejected} dupReverts=${summary.duplicateReverts} realloc=${summary.reallocations} fraudSettled=${summary.fraudSettled}`,
  );
  if (
    summary.settled >= TARGET_SETTLED &&
    summary.payments >= TARGET_SETTLED &&
    summary.rejected >= 1 &&
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
if (summary.rejected < 1) failures.push("no rejected claim");
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
