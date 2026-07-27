// Settlement loop: consumes VERIFIED claims whose dispute window has passed,
// recognizes the payout in the escrow (autoSettle — where cap/budget
// invariants are enforced on-chain), then fires the instant per-conversion
// payment to the publisher. Payment never runs ahead of recognition (I-1).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import {
  campaignEscrowAbi,
  campaignIdFromName,
  chainEnvFromProcess,
  conversionRegistryAbi,
  loadDemoConfig,
  loadWallets,
  publicClient,
  walletClient,
} from "@convertrail/shared";
import { NanopaymentsRail } from "./rail.ts";

const config = loadDemoConfig();
const wallets = loadWallets();
const env = chainEnvFromProcess();
const pub = publicClient(env);
const wallet = walletClient(env, wallets.operational.privateKey);
const rail = new NanopaymentsRail(wallets.operational.privateKey, env);
const campaignId = campaignIdFromName(config.campaign.name);
const price = BigInt(config.campaign.pricePerConversion);
const windowBlocks = BigInt(config.campaign.disputeWindowBlocks);
const maxRecognizedRaw = process.env.SETTLEMENT_MAX_RECOGNIZED;
const maxRecognized = maxRecognizedRaw === undefined ? undefined : Number(maxRecognizedRaw);
if (
  maxRecognized !== undefined &&
  (!Number.isSafeInteger(maxRecognized) || maxRecognized <= 0)
) {
  throw new Error(`invalid SETTLEMENT_MAX_RECOGNIZED ${maxRecognizedRaw}`);
}

mkdirSync(".e2e", { recursive: true });
const PAYMENTS_LOG = ".e2e/payments.jsonl";
const RUN_LOG = ".e2e/run.json";

interface PendingClaim {
  claimId: bigint;
  publisher: Address;
  verdictAtBlock: bigint;
  recognitionTx?: Hex;
  paymentAttempts: number;
  nextRetryAt: number;
}

const pending = new Map<bigint, PendingClaim>();
const paid = new Set<bigint>();
if (existsSync(PAYMENTS_LOG)) {
  for (const line of readFileSync(PAYMENTS_LOG, "utf8").trim().split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as { campaignId?: string; claimId?: string };
    if (row.campaignId === campaignId && row.claimId !== undefined) paid.add(BigInt(row.claimId));
  }
}

const campaign = await pub.readContract({
  address: env.campaignEscrow,
  abi: campaignEscrowAbi,
  functionName: "getCampaign",
  args: [campaignId],
});
let settledCount = Number(campaign.recognizedTotal / price);
if (!Number.isSafeInteger(settledCount)) throw new Error("campaign recognized count exceeds safe integer range");

let recoveryFromBlock: bigint | undefined;
if (existsSync(RUN_LOG)) {
  const run = JSON.parse(readFileSync(RUN_LOG, "utf8")) as {
    campaignId?: string;
    startBlock?: string;
  };
  if (run.campaignId === campaignId && run.startBlock !== undefined) {
    recoveryFromBlock = BigInt(run.startBlock);
  }
}

function rememberClaim(
  claimId: bigint,
  publisher: Address,
  verdictAtBlock: bigint,
  recognitionTx?: Hex,
): void {
  if (paid.has(claimId)) return;
  const existing = pending.get(claimId);
  pending.set(claimId, {
    claimId,
    publisher,
    verdictAtBlock,
    recognitionTx: recognitionTx ?? existing?.recognitionTx,
    paymentAttempts: existing?.paymentAttempts ?? 0,
    nextRetryAt: existing?.nextRetryAt ?? 0,
  });
}

async function loadClaim(claimId: bigint, recognitionTx?: Hex): Promise<void> {
  const claim = await pub.readContract({
    address: env.conversionRegistry,
    abi: conversionRegistryAbi,
    functionName: "getClaim",
    args: [claimId],
  });
  rememberClaim(claimId, claim.publisher, BigInt(claim.verdictAtBlock), recognitionTx);
}

let lastBlock = await pub.getBlockNumber();
if (recoveryFromBlock !== undefined && recoveryFromBlock <= lastBlock) {
  const [verifiedLogs, recognizedLogs] = await Promise.all([
    pub.getContractEvents({
      address: env.conversionRegistry,
      abi: conversionRegistryAbi,
      eventName: "ClaimVerified",
      fromBlock: recoveryFromBlock,
      toBlock: lastBlock,
    }),
    pub.getContractEvents({
      address: env.campaignEscrow,
      abi: campaignEscrowAbi,
      eventName: "PayoutRecognized",
      fromBlock: recoveryFromBlock,
      toBlock: lastBlock,
    }),
  ]);
  const recognized = new Map<bigint, Hex>();
  for (const log of recognizedLogs) {
    const args = log.args as { campaignId: Hex; claimId: bigint };
    if (args.campaignId === campaignId) recognized.set(args.claimId, log.transactionHash);
  }
  for (const log of verifiedLogs) {
    const args = log.args as { campaignId: Hex; claimId: bigint };
    if (args.campaignId !== campaignId || paid.has(args.claimId)) continue;
    const recognitionTx = recognized.get(args.claimId);
    if (recognitionTx === undefined && maxRecognized !== undefined && settledCount >= maxRecognized) continue;
    await loadClaim(args.claimId, recognitionTx);
  }
  // A crash can happen after recognition but before the corresponding
  // ClaimVerified scan is replayed. Treat the escrow event as authoritative.
  for (const [claimId, txHash] of recognized) {
    if (!pending.has(claimId) && !paid.has(claimId)) await loadClaim(claimId, txHash);
  }
}
console.log(
  `settlement watching from block ${lastBlock}` +
    (pending.size > 0 ? ` (${pending.size} unpaid/verified claims recovered)` : "") +
    (maxRecognized === undefined ? "" : ` (recognition cap ${maxRecognized})`),
);
console.log(`paying from ${rail.payerAddress} signed by ${rail.signerKind}`);

async function collectVerified(current: bigint): Promise<void> {
  const logs = await pub.getContractEvents({
    address: env.conversionRegistry,
    abi: conversionRegistryAbi,
    eventName: "ClaimVerified",
    fromBlock: lastBlock + 1n,
    toBlock: current,
  });
  lastBlock = current;
  for (const log of logs) {
    const args = log.args as { campaignId: Hex; claimId: bigint };
    if (args.campaignId === campaignId) await loadClaim(args.claimId);
  }
}

async function recoverRecognition(claim: PendingClaim): Promise<boolean> {
  const current = await pub.getBlockNumber();
  const fromBlock = recoveryFromBlock ?? (current > 10_000n ? current - 10_000n : 0n);
  const logs = await pub.getContractEvents({
    address: env.campaignEscrow,
    abi: campaignEscrowAbi,
    eventName: "PayoutRecognized",
    fromBlock,
    toBlock: current,
  });
  const match = logs.find((log) => {
    const args = log.args as { campaignId: Hex; claimId: bigint };
    return args.campaignId === campaignId && args.claimId === claim.claimId;
  });
  if (!match) return false;
  claim.recognitionTx = match.transactionHash;
  const currentCampaign = await pub.readContract({
    address: env.campaignEscrow,
    abi: campaignEscrowAbi,
    functionName: "getCampaign",
    args: [campaignId],
  });
  settledCount = Number(currentCampaign.recognizedTotal / price);
  return true;
}

async function settleDue(current: bigint): Promise<void> {
  for (const claim of [...pending.values()]) {
    if (current <= claim.verdictAtBlock + windowBlocks) continue;
    if (paid.has(claim.claimId)) {
      pending.delete(claim.claimId);
      continue;
    }
    if (Date.now() < claim.nextRetryAt) continue;
    if (claim.recognitionTx === undefined && maxRecognized !== undefined && settledCount >= maxRecognized) {
      continue;
    }

    try {
      if (claim.recognitionTx === undefined) {
        const hash = await wallet.writeContract({
          address: env.campaignEscrow,
          abi: campaignEscrowAbi,
          functionName: "autoSettle",
          args: [claim.claimId],
        });
        const receipt = await pub.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`autoSettle reverted (${hash})`);
        claim.recognitionTx = hash;
        settledCount++;
      }

      const payment = await rail.pay(claim.publisher, price, `claim/${claim.claimId}`);
      appendFileSync(
        PAYMENTS_LOG,
        JSON.stringify({
          campaignId,
          campaignName: config.campaign.name,
          claimId: claim.claimId.toString(),
          publisher: claim.publisher,
          amount: price.toString(),
          ref: payment.ref,
          elapsedMs: payment.elapsedMs,
          settleTx: claim.recognitionTx,
        }) + "\n",
      );
      paid.add(claim.claimId);
      pending.delete(claim.claimId);
      console.log(
        `claim ${claim.claimId}: recognized (tx=${claim.recognitionTx.slice(0, 14)}...) + paid ${price} ` +
          `to ${claim.publisher.slice(0, 10)}... in ${payment.elapsedMs}ms (ref ${payment.ref.slice(0, 8)})`,
      );
    } catch (err) {
      // Disputed claims revert with ClaimNotVerified — permanent skip.
      // Payment/RPC failures remain queued with bounded backoff. In particular,
      // a recognized claim must never disappear before its payment is logged.
      const msg = (err as Error).message;
      if (claim.recognitionTx === undefined && msg.includes("AlreadyRecognized") && await recoverRecognition(claim)) {
        claim.nextRetryAt = Date.now() + 2_000;
        console.log(`claim ${claim.claimId}: recovered prior recognition; payment retry queued`);
      } else if (claim.recognitionTx === undefined && msg.includes("ClaimNotVerified")) {
        paid.add(claim.claimId);
        pending.delete(claim.claimId);
        console.log(`claim ${claim.claimId}: skipped (disputed)`);
      } else {
        claim.paymentAttempts++;
        const retryMs = Math.min(30_000, 2_000 * 2 ** Math.min(claim.paymentAttempts - 1, 4));
        claim.nextRetryAt = Date.now() + retryMs;
        console.error(
          `claim ${claim.claimId}: settle FAILED (retry in ${retryMs / 1000}s): ${msg.split("\n")[0]}`,
        );
      }
    }
  }
}

let lastTrueUpAt = 0;
async function trueUpPeriodically(): Promise<void> {
  if (settledCount - lastTrueUpAt < 10) return;
  lastTrueUpAt = settledCount;
  try {
    const hash = await wallet.writeContract({
      address: env.campaignEscrow,
      abi: campaignEscrowAbi,
      functionName: "trueUp",
      args: [campaignId],
    });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`true-up executed (tx=${hash.slice(0, 14)}...)`);
  } catch (err) {
    console.error("true-up failed:", (err as Error).message.split("\n")[0]);
  }
}

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    const current = await pub.getBlockNumber();
    if (current > lastBlock) await collectVerified(current);
    await settleDue(current);
    await trueUpPeriodically();
  } catch (err) {
    console.error("settlement loop error:", (err as Error).message.split("\n")[0]);
  } finally {
    ticking = false;
  }
}, 2_000);
