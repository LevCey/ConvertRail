// Fraud agent — the demo's scripted antagonist. Two attack classes:
//   duplicate:  replays the nullifier of a conversion the clean publisher
//               already claimed — refused by the contract itself (real
//               on-chain revert, visible in the explorer)
//   fabricated: submits a fresh nullifier with an evidence hash matching no
//               signed merchant event — rejected by the verifier on-chain
// Attack mix and rate are deterministic script parameters (reproducible takes).
import { appendFileSync, mkdirSync } from "node:fs";
import { encodeFunctionData, keccak256, stringToBytes } from "viem";
import {
  campaignIdFromName,
  chainEnvFromProcess,
  conversionRegistryAbi,
  evidenceHash,
  loadDemoConfig,
  loadWallets,
  nullifier,
  publicClient,
  walletClient,
  type SignedConversionEvent,
} from "@convertrail/shared";

const config = loadDemoConfig();
const wallets = loadWallets();
const env = chainEnvFromProcess();
const pub = publicClient(env);
const wallet = walletClient(env, wallets[config.fraud.id].privateKey);
const campaignId = campaignIdFromName(config.campaign.name);
const merchantBase = `http://localhost:${config.merchantSim.port}`;
const victimId = config.publishers[0].id;

mkdirSync(".e2e", { recursive: true });
const FRAUD_LOG = ".e2e/fraud.jsonl";

let attackCounter = 0;
let victimEvents: SignedConversionEvent[] = [];

async function refreshVictimEvents(): Promise<void> {
  const res = await fetch(`${merchantBase}/events?publisherId=${victimId}&sinceSeq=0`);
  if (!res.ok) return;
  const body = (await res.json()) as { events: { event: SignedConversionEvent }[] };
  victimEvents = body.events.map((e) => e.event);
}

/** Duplicate attack: the tx is sent with fixed gas so it lands on-chain and
 * reverts there — the refusal shown in the demo is chain state, never a
 * client-side simulation (per the demo integrity rules). */
async function duplicateAttack(): Promise<void> {
  await refreshVictimEvents();
  // Oldest victim event: most likely already claimed by the clean publisher.
  const target = victimEvents[0];
  if (!target) return;
  const data = encodeFunctionData({
    abi: conversionRegistryAbi,
    functionName: "submitClaim",
    args: [campaignId, nullifier(campaignId, target.conversionId), evidenceHash(target)],
  });
  const hash = await wallet.sendTransaction({
    to: env.conversionRegistry,
    data,
    gas: 300_000n, // fixed: skips estimateGas so the revert happens on-chain
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  appendFileSync(
    FRAUD_LOG,
    JSON.stringify({ type: "duplicate", txHash: hash, status: receipt.status, conversionId: target.conversionId }) + "\n",
  );
  console.log(`duplicate attack on ${target.conversionId}: ${receipt.status} tx=${hash.slice(0, 14)}...`);
}

async function fabricatedAttack(): Promise<void> {
  const fakeId = `fake-${++attackCounter}`;
  const fakeEvidence = keccak256(stringToBytes(`no-such-event-${attackCounter}-${Date.now()}`));
  const hash = await wallet.writeContract({
    address: env.conversionRegistry,
    abi: conversionRegistryAbi,
    functionName: "submitClaim",
    args: [campaignId, nullifier(campaignId, fakeId), fakeEvidence],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  appendFileSync(
    FRAUD_LOG,
    JSON.stringify({ type: "fabricated", txHash: hash, status: receipt.status, conversionId: fakeId }) + "\n",
  );
  console.log(`fabricated attack ${fakeId}: submitted tx=${hash.slice(0, 14)}...`);
}

let turn = 0;
console.log(`fraud agent ${config.fraud.id} (${wallets[config.fraud.id].address}) attacking every ${config.fraud.attackIntervalMs}ms`);

setInterval(async () => {
  try {
    // Deterministic alternation: fabricated, duplicate, fabricated, ...
    if (turn++ % 2 === 0) await fabricatedAttack();
    else await duplicateAttack();
  } catch (err) {
    console.error("fraud loop error:", (err as Error).message.split("\n")[0]);
  }
}, config.fraud.attackIntervalMs);
