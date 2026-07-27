// Fraud agent — the demo's scripted antagonist. Three attack classes, one per
// deterministic rule the verification layer enforces:
//   duplicate:   replays the nullifier of a conversion the clean publisher
//                already claimed — refused by the contract itself (real
//                on-chain revert, visible in the explorer)
//   fabricated:  submits a fresh nullifier with an evidence hash matching no
//                signed merchant event — rejected as EVIDENCE_MISMATCH
//   bot traffic: claims its own synthetic conversions, which are genuine
//                merchant events but convert impossibly soon after the click
//                — rejected as TIMING_ANOMALY
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
const fraudPublisher = wallets[config.fraud.id].address;
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
  const replayedNullifier = nullifier(campaignId, target.conversionId);
  const replayedEvidenceHash = evidenceHash(target);
  const data = encodeFunctionData({
    abi: conversionRegistryAbi,
    functionName: "submitClaim",
    args: [campaignId, replayedNullifier, replayedEvidenceHash],
  });
  const hash = await wallet.sendTransaction({
    to: env.conversionRegistry,
    data,
    gas: 300_000n, // fixed: skips estimateGas so the revert happens on-chain
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  appendFileSync(
    FRAUD_LOG,
    JSON.stringify({
      type: "duplicate",
      campaignId,
      campaignName: config.campaign.name,
      publisher: fraudPublisher,
      nullifier: replayedNullifier,
      evidenceHash: replayedEvidenceHash,
      txHash: hash,
      status: receipt.status,
      conversionId: target.conversionId,
    }) + "\n",
  );
  console.log(`duplicate attack on ${target.conversionId}: ${receipt.status} tx=${hash.slice(0, 14)}...`);
}

async function fabricatedAttack(): Promise<void> {
  const fakeId = `fake-${++attackCounter}`;
  const fakeEvidence = keccak256(stringToBytes(`no-such-event-${attackCounter}-${Date.now()}`));
  const fakeNullifier = nullifier(campaignId, fakeId);
  const hash = await wallet.writeContract({
    address: env.conversionRegistry,
    abi: conversionRegistryAbi,
    functionName: "submitClaim",
    args: [campaignId, fakeNullifier, fakeEvidence],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  appendFileSync(
    FRAUD_LOG,
    JSON.stringify({
      type: "fabricated",
      campaignId,
      campaignName: config.campaign.name,
      publisher: fraudPublisher,
      nullifier: fakeNullifier,
      evidenceHash: fakeEvidence,
      txHash: hash,
      status: receipt.status,
      conversionId: fakeId,
    }) + "\n",
  );
  console.log(`fabricated attack ${fakeId}: submitted tx=${hash.slice(0, 14)}...`);
}

/** Bot-traffic attack: the evidence is a real signed merchant event, so it
 * survives hash validation and the publisher binding — the timing rule is what
 * refuses it. Each event is claimed at most once; the registry would revert a
 * repeat as a duplicate, which is a different attack. */
let botSinceSeq = 0;

async function botTrafficAttack(): Promise<void> {
  if (!config.fraud.botTraffic) return;
  const res = await fetch(
    `${merchantBase}/events?publisherId=${config.fraud.id}&sinceSeq=${botSinceSeq}`,
  );
  if (!res.ok) return;
  const body = (await res.json()) as { events: { seq: number; event: SignedConversionEvent }[] };
  const next = body.events[0];
  if (!next) return;
  botSinceSeq = Math.max(botSinceSeq, next.seq);

  const botNullifier = nullifier(campaignId, next.event.conversionId);
  const botEvidenceHash = evidenceHash(next.event);
  const hash = await wallet.writeContract({
    address: env.conversionRegistry,
    abi: conversionRegistryAbi,
    functionName: "submitClaim",
    args: [campaignId, botNullifier, botEvidenceHash],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  appendFileSync(
    FRAUD_LOG,
    JSON.stringify({
      type: "bot_traffic",
      campaignId,
      campaignName: config.campaign.name,
      publisher: fraudPublisher,
      nullifier: botNullifier,
      evidenceHash: botEvidenceHash,
      txHash: hash,
      status: receipt.status,
      conversionId: next.event.conversionId,
    }) + "\n",
  );
  console.log(
    `bot-traffic attack ${next.event.conversionId} (${next.event.conversionTs - next.event.clickTs}ms click-to-conversion): submitted tx=${hash.slice(0, 14)}...`,
  );
}

let turn = 0;
console.log(`fraud agent ${config.fraud.id} (${fraudPublisher}) attacking every ${config.fraud.attackIntervalMs}ms`);

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    // Deterministic rotation: fabricated, duplicate, bot traffic, repeat.
    const which = turn++ % 3;
    if (which === 0) await fabricatedAttack();
    else if (which === 1) await duplicateAttack();
    else await botTrafficAttack();
  } catch (err) {
    console.error("fraud loop error:", (err as Error).message.split("\n")[0]);
  } finally {
    ticking = false;
  }
}, config.fraud.attackIntervalMs);
