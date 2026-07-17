// Chain adapter around the pure decision core: watches ClaimSubmitted,
// fetches evidence from the merchant source by hash, posts verdicts on-chain.
// Holds no funds and has no payment capability — separation of duties from
// the settlement module is a trust boundary, not a convention.
import type { Address, Hex } from "viem";
import {
  campaignIdFromName,
  chainEnvFromProcess,
  conversionRegistryAbi,
  loadDemoConfig,
  loadWallets,
  policyHash,
  campaignEscrowAbi,
  publicClient,
  publisherBinding,
  REJECT_REASON,
  walletClient,
  type SignedConversionEvent,
} from "@convertrail/shared";
import { decide } from "./core.ts";

const config = loadDemoConfig();
const wallets = loadWallets();
const env = chainEnvFromProcess();
const pub = publicClient(env);
const wallet = walletClient(env, wallets.verifier.privateKey);
const campaignId = campaignIdFromName(config.campaign.name);
const merchantBase = `http://localhost:${config.merchantSim.port}`;

const binding = publisherBinding(wallets, [
  ...config.publishers.map((p) => p.id),
  config.fraud.id,
]);

// R6.4: refuse to run under a policy that differs from the one committed
// on-chain — the rules the referee applies must be the published ones.
const localPolicyHash = policyHash(config.verification);
const campaign = await pub
  .readContract({
    address: env.campaignEscrow,
    abi: campaignEscrowAbi,
    functionName: "getCampaign",
    args: [campaignId],
  })
  .catch(() => null);
if (campaign && campaign.policyHash !== localPolicyHash) {
  console.error(`FATAL: on-chain policy hash ${campaign.policyHash} != local ${localPolicyHash}`);
  process.exit(1);
}

// Rate state: submission timestamps per publisher, pruned to the window.
const claimTimes = new Map<Address, number[]>();

function priorClaims(publisher: Address, nowMs: number): number[] {
  const cutoff = nowMs - config.verification.rateWindowMs;
  const list = (claimTimes.get(publisher) ?? []).filter((t) => t >= cutoff);
  claimTimes.set(publisher, list);
  return list;
}

async function fetchEventByHash(hash: Hex): Promise<SignedConversionEvent | null> {
  const res = await fetch(`${merchantBase}/event-by-hash/${hash}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`merchant-sim ${res.status}`);
  const body = (await res.json()) as { event: SignedConversionEvent };
  return body.event;
}

let lastBlock = await pub.getBlockNumber();
console.log(`verifier watching from block ${lastBlock} (policy ${localPolicyHash.slice(0, 10)}...)`);

setInterval(async () => {
  try {
    const current = await pub.getBlockNumber();
    if (current <= lastBlock) return;
    const logs = await pub.getContractEvents({
      address: env.conversionRegistry,
      abi: conversionRegistryAbi,
      eventName: "ClaimSubmitted",
      fromBlock: lastBlock + 1n,
      toBlock: current,
    });
    lastBlock = current;

    for (const log of logs) {
      const { claimId, campaignId: cid, publisher, nullifier, evidenceHash } = log.args as {
        claimId: bigint;
        campaignId: Hex;
        publisher: Address;
        nullifier: Hex;
        evidenceHash: Hex;
      };
      const nowMs = Date.now();
      const prior = priorClaims(publisher, nowMs);
      const event = await fetchEventByHash(evidenceHash);
      const verdict = decide(
        { campaignId: cid, publisher, nullifier, evidenceHash },
        event,
        binding,
        config.verification,
        prior,
      );
      prior.push(nowMs);

      const approved = verdict.approved;
      const reason = approved ? REJECT_REASON.NONE : REJECT_REASON[verdict.reason];
      const hash = await wallet.writeContract({
        address: env.conversionRegistry,
        abi: conversionRegistryAbi,
        functionName: "postVerdict",
        args: [claimId, approved, reason],
      });
      await pub.waitForTransactionReceipt({ hash });
      console.log(
        `claim ${claimId}: ${approved ? "VERIFIED" : `REJECTED(${!approved ? verdict.reason : ""})`} tx=${hash.slice(0, 14)}...`,
      );
    }
  } catch (err) {
    console.error("verifier loop error:", (err as Error).message);
  }
}, 2_000);
