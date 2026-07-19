// Settlement loop: consumes VERIFIED claims whose dispute window has passed,
// recognizes the payout in the escrow (autoSettle — where cap/budget
// invariants are enforced on-chain), then fires the instant per-conversion
// payment to the publisher. Payment never runs ahead of recognition (I-1).
import { appendFileSync, mkdirSync } from "node:fs";
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

mkdirSync(".e2e", { recursive: true });
const PAYMENTS_LOG = ".e2e/payments.jsonl";

interface PendingClaim {
  claimId: bigint;
  publisher: Address;
  verdictAtBlock: bigint;
}

const pending = new Map<bigint, PendingClaim>();
const done = new Set<bigint>();
let settledCount = 0;
let lastBlock = await pub.getBlockNumber();
console.log(`settlement watching from block ${lastBlock}`);

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
    const claimId = (log.args as { claimId: bigint }).claimId;
    const claim = await pub.readContract({
      address: env.conversionRegistry,
      abi: conversionRegistryAbi,
      functionName: "getClaim",
      args: [claimId],
    });
    pending.set(claimId, {
      claimId,
      publisher: claim.publisher,
      verdictAtBlock: BigInt(claim.verdictAtBlock),
    });
  }
}

async function settleDue(current: bigint): Promise<void> {
  for (const claim of [...pending.values()]) {
    if (current <= claim.verdictAtBlock + windowBlocks) continue;
    pending.delete(claim.claimId);
    if (done.has(claim.claimId)) continue;

    try {
      const hash = await wallet.writeContract({
        address: env.campaignEscrow,
        abi: campaignEscrowAbi,
        functionName: "autoSettle",
        args: [claim.claimId],
      });
      await pub.waitForTransactionReceipt({ hash });
      done.add(claim.claimId);
      settledCount++;

      const payment = await rail.pay(claim.publisher, price, `claim/${claim.claimId}`);
      appendFileSync(
        PAYMENTS_LOG,
        JSON.stringify({
          claimId: claim.claimId.toString(),
          publisher: claim.publisher,
          amount: price.toString(),
          ref: payment.ref,
          elapsedMs: payment.elapsedMs,
          settleTx: hash,
        }) + "\n",
      );
      console.log(
        `claim ${claim.claimId}: recognized (tx=${hash.slice(0, 14)}...) + paid ${price} to ${claim.publisher.slice(0, 10)}... in ${payment.elapsedMs}ms (ref ${payment.ref.slice(0, 8)})`,
      );
    } catch (err) {
      // Disputed claims revert with ClaimNotVerified — permanent skip.
      // Anything else (cap/budget exhausted, transient RPC) is logged loud.
      const msg = (err as Error).message;
      if (msg.includes("ClaimNotVerified")) {
        done.add(claim.claimId);
        console.log(`claim ${claim.claimId}: skipped (disputed)`);
      } else {
        console.error(`claim ${claim.claimId}: settle FAILED: ${msg.split("\n")[0]}`);
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
