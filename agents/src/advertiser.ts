// Advertiser agent: funds the escrow, publishes campaign rules, then watches
// verified-conversion quality per publisher on-chain and autonomously shifts
// budget away from low-quality traffic. Decision logic is the deterministic
// policy in policy.ts over real on-chain signals — nothing else.
import { erc20Abi, parseEther, stringToHex, type Address } from "viem";
import {
  campaignEscrowAbi,
  campaignIdFromName,
  chainEnvFromProcess,
  conversionRegistryAbi,
  loadDemoConfig,
  loadWallets,
  policyHash,
  publicClient,
  publisherBinding,
  walletClient,
} from "@proof-of-conversion/shared";
import { evaluate, pickTarget, type Outcome } from "./policy.ts";

const config = loadDemoConfig();
const wallets = loadWallets();
const env = chainEnvFromProcess();
const pub = publicClient(env);
const wallet = walletClient(env, wallets.advertiser.privateKey);
const campaignId = campaignIdFromName(config.campaign.name);

const publisherIds = [...config.publishers.map((p) => p.id), config.fraud.id];
const binding = publisherBinding(wallets, publisherIds);
const publisherAddresses = publisherIds.map((id) => binding[id]);

async function ensureCampaign(): Promise<void> {
  const existing = await pub
    .readContract({
      address: env.campaignEscrow,
      abi: campaignEscrowAbi,
      functionName: "getCampaign",
      args: [campaignId],
    })
    .catch(() => null);
  if (existing) {
    console.log(`campaign ${config.campaign.name} already on-chain`);
    return;
  }

  const budget = BigInt(config.campaign.budget);
  const approveTx = await wallet.writeContract({
    address: env.usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [env.campaignEscrow, budget],
  });
  await pub.waitForTransactionReceipt({ hash: approveTx });

  const caps = publisherIds.map((id) => {
    const cap = config.campaign.caps[id];
    if (!cap) throw new Error(`no cap configured for ${id}`);
    return BigInt(cap);
  });
  const createTx = await wallet.writeContract({
    address: env.campaignEscrow,
    abi: campaignEscrowAbi,
    functionName: "createCampaign",
    args: [
      campaignId,
      wallets.operational.address,
      BigInt(config.campaign.pricePerConversion),
      budget,
      config.campaign.disputeWindowBlocks,
      policyHash(config.verification),
      publisherAddresses,
      caps,
    ],
    value: parseEther(config.campaign.gasProvisionEther),
  });
  await pub.waitForTransactionReceipt({ hash: createTx });
  console.log(`campaign created: ${config.campaign.name} (tx=${createTx.slice(0, 14)}...)`);
}

await ensureCampaign();

// Ordered verdict history, rebuilt from chain events every tick — the agent's
// entire world model is public chain state.
const reallocatedFrom = new Set<string>();
let lastBlock = await pub.getBlockNumber();
const outcomes: Outcome[] = [];

console.log(`advertiser agent watching from block ${lastBlock}`);

setInterval(async () => {
  try {
    const current = await pub.getBlockNumber();
    if (current <= lastBlock) return;
    const [verified, rejected] = await Promise.all([
      pub.getContractEvents({
        address: env.conversionRegistry,
        abi: conversionRegistryAbi,
        eventName: "ClaimVerified",
        fromBlock: lastBlock + 1n,
        toBlock: current,
      }),
      pub.getContractEvents({
        address: env.conversionRegistry,
        abi: conversionRegistryAbi,
        eventName: "ClaimRejected",
        fromBlock: lastBlock + 1n,
        toBlock: current,
      }),
    ]);
    lastBlock = current;

    const merged = [...verified.map((l) => ({ log: l, approved: true })), ...rejected.map((l) => ({ log: l, approved: false }))]
      .filter((e) => (e.log.args as { campaignId: `0x${string}` }).campaignId === campaignId)
      .sort((a, b) => {
        const ca = (a.log.args as { claimId: bigint }).claimId;
        const cb = (b.log.args as { claimId: bigint }).claimId;
        return ca < cb ? -1 : ca > cb ? 1 : 0;
      });
    for (const entry of merged) {
      outcomes.push({
        publisher: (entry.log.args as { publisher: Address }).publisher,
        approved: entry.approved,
      });
    }
    if (merged.length === 0) return;

    const decision = evaluate(outcomes, config.reallocation);
    if (!decision || reallocatedFrom.has(decision.from.toLowerCase())) return;

    const target = pickTarget(outcomes, config.reallocation, publisherAddresses, decision.from);
    if (!target) return;

    const allocation = await pub.readContract({
      address: env.campaignEscrow,
      abi: campaignEscrowAbi,
      functionName: "getAllocation",
      args: [campaignId, decision.from],
    });
    const headroom = BigInt(allocation.cap) - BigInt(allocation.recognized);
    const amount = (headroom * BigInt(Math.round(config.reallocation.shiftFraction * 100))) / 100n;
    if (amount === 0n) return;

    const hash = await wallet.writeContract({
      address: env.campaignEscrow,
      abi: campaignEscrowAbi,
      functionName: "reallocate",
      args: [campaignId, decision.from, target, amount, stringToHex(decision.reason, { size: 32 })],
    });
    await pub.waitForTransactionReceipt({ hash });
    reallocatedFrom.add(decision.from.toLowerCase());
    console.log(
      `REALLOCATED ${amount} from ${decision.from.slice(0, 10)}... to ${target.slice(0, 10)}... (${decision.reason}) tx=${hash.slice(0, 14)}...`,
    );
  } catch (err) {
    console.error("advertiser loop error:", (err as Error).message.split("\n")[0]);
  }
}, 3_000);
