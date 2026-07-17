// Headless end-to-end run against Arc testnet: starts every component,
// drives the full adversarial loop, and asserts the outcome. Fails loud
// (non-zero exit, named check) if any target is missed within the deadline.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  campaignEscrowAbi,
  campaignIdFromName,
  chainEnvFromProcess,
  conversionRegistryAbi,
  loadDemoConfig,
  loadWallets,
  publicClient,
} from "@proof-of-conversion/shared";

const TARGET_SETTLED = Number(process.env.E2E_TARGET_SETTLED ?? 20);
const DEADLINE_MS = Number(process.env.E2E_DEADLINE_MS ?? 15 * 60_000);

const config = loadDemoConfig();
const wallets = loadWallets();
const env = chainEnvFromProcess();
const pub = publicClient(env);
const campaignId = campaignIdFromName(config.campaign.name);
const fraudAddress = wallets[config.fraud.id].address.toLowerCase();

rmSync(".e2e", { recursive: true, force: true });

const children: ChildProcess[] = [];
function run(name: string, args: string[]): ChildProcess {
  const child = spawn("node", args, { env: process.env });
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
run("settlement", ["settlement/src/main.ts"]);
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

async function collect(): Promise<Summary> {
  const current = await pub.getBlockNumber();
  const [settledLogs, rejectedLogs, disputedLogs, reallocLogs] = await Promise.all([
    pub.getContractEvents({
      address: env.conversionRegistry, abi: conversionRegistryAbi, eventName: "ClaimSettled",
      fromBlock: startBlock, toBlock: current,
    }),
    pub.getContractEvents({
      address: env.conversionRegistry, abi: conversionRegistryAbi, eventName: "ClaimRejected",
      fromBlock: startBlock, toBlock: current,
    }),
    pub.getContractEvents({
      address: env.conversionRegistry, abi: conversionRegistryAbi, eventName: "ClaimDisputed",
      fromBlock: startBlock, toBlock: current,
    }),
    pub.getContractEvents({
      address: env.campaignEscrow, abi: campaignEscrowAbi, eventName: "BudgetReallocated",
      fromBlock: startBlock, toBlock: current,
    }),
  ]);

  const fraudLog = existsSync(".e2e/fraud.jsonl")
    ? readFileSync(".e2e/fraud.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const payments = existsSync(".e2e/payments.jsonl")
    ? readFileSync(".e2e/payments.jsonl", "utf8").trim().split("\n").filter(Boolean).length
    : 0;

  return {
    settled: settledLogs.length,
    rejected: rejectedLogs.length,
    disputed: disputedLogs.length,
    fraudSettled: settledLogs.filter(
      (l) => (l.args as { publisher: string }).publisher.toLowerCase() === fraudAddress,
    ).length,
    reallocations: reallocLogs.length,
    duplicateReverts: fraudLog.filter((e) => e.type === "duplicate" && e.status === "reverted").length,
    payments,
  };
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

shutdown();

const failures: string[] = [];
if (summary.settled < TARGET_SETTLED) failures.push(`settled ${summary.settled} < ${TARGET_SETTLED}`);
if (summary.payments < summary.settled) failures.push(`payments ${summary.payments} < settled ${summary.settled}`);
if (summary.rejected < 1) failures.push("no rejected claim");
if (summary.duplicateReverts < 1) failures.push("no on-chain duplicate revert");
if (summary.reallocations < 1) failures.push("no autonomous reallocation");
if (summary.fraudSettled > 0) failures.push(`fraud publisher got ${summary.fraudSettled} settlements`);

console.log("\n[e2e] final:", JSON.stringify(summary));
if (failures.length > 0) {
  console.error("[e2e] FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("[e2e] PASSED: full adversarial loop verified on Arc testnet");
process.exit(0);
