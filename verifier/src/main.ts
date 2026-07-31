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
import { decide, type FundingLink } from "./core.ts";

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
  ...(config.fraud.sybil ? [config.fraud.sybil.id] : []),
]);

// Every address with a stake in this campaign. A claimant funded out of one of
// these wallets is not an independent party, whatever its evidence says.
const participants = new Set<Address>(
  [...Object.values(binding), wallets.advertiser.address].map((a) => a.toLowerCase() as Address),
);

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

// --- Funding graph -------------------------------------------------------
// Identity integrity is resolved from the same public chain anyone else can
// read: who sent native value to whom. Only top-level transfers are visible to
// eth_getBlockByNumber, so the index makes no claim about value moved by
// internal calls — a stated limit of the method, not a hidden one.
const fundedBy = new Map<string, Set<string>>(); // recipient -> its funders
const funded = new Map<string, Set<string>>(); // funder -> whom it funded

function addEdge(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

async function indexBlock(blockNumber: bigint): Promise<void> {
  const block = await pub.getBlock({ blockNumber, includeTransactions: true });
  for (const tx of block.transactions) {
    if (typeof tx === "string" || !tx.to || tx.value === 0n) continue;
    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    if (from === to) continue;
    addEdge(fundedBy, to, from);
    addEdge(funded, from, to);
  }
}

/** Claims are decided against a funding index that covers their own block, so
 * a verdict never depends on how far the indexer happened to have run. */
async function ensureFundingIndexed(upTo: bigint): Promise<void> {
  while (fundingCursor < upTo) {
    const next = fundingCursor + 1n;
    await indexBlock(next);
    fundingCursor = next;
  }
}

const hubsReported = new Set<string>();

/** Deterministic by construction: funders and siblings are sorted, so the link
 * returned depends on the graph, never on the order blocks were indexed. */
function resolveFundingLink(claimant: Address): FundingLink | null {
  const self = claimant.toLowerCase();
  const funders = [...(fundedBy.get(self) ?? [])].sort();

  for (const f of funders) {
    if (f !== self && participants.has(f as Address)) {
      return { counterparty: f as Address, hops: 1 };
    }
  }

  // Two participants funded from one wallet are one operator — unless that
  // wallet funds everyone. Faucets and provisioning wallets prove nothing, and
  // treating them as evidence would merge every unrelated publisher into a
  // single cluster.
  for (const f of funders) {
    const degree = funded.get(f)?.size ?? 0;
    if (degree >= config.verification.fundingHubMinDegree) {
      if (!hubsReported.has(f)) {
        hubsReported.add(f);
        console.log(`funding index: ${f.slice(0, 10)}... funds ${degree} addresses — treated as infrastructure`);
      }
      continue;
    }
    for (const sibling of [...(funded.get(f) ?? [])].sort()) {
      if (sibling !== self && participants.has(sibling as Address)) {
        return { counterparty: sibling as Address, hops: 2, via: f as Address };
      }
    }
  }
  return null;
}

let lastBlock = await pub.getBlockNumber();
const scanDepth = BigInt(config.verification.fundingScanDepthBlocks);
let fundingCursor = scanDepth >= lastBlock ? 0n : lastBlock - scanDepth;
if (scanDepth > 0n) {
  const startedAt = Date.now();
  console.log(`funding index: backfilling blocks ${fundingCursor}..${lastBlock}`);
  await ensureFundingIndexed(lastBlock);
  console.log(
    `funding index: ${fundedBy.size} funded addresses, ${funded.size} funders ` +
      `(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
  );
}

console.log(`verifier watching from block ${lastBlock} (policy ${localPolicyHash.slice(0, 10)}...)`);

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
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
    // Keep the funding graph level with the watch loop. The per-claim call
    // below still guarantees coverage of a claim's own block; doing it here as
    // well keeps that guarantee cheap instead of letting the index fall behind
    // and stall verdict posting while it catches up.
    await ensureFundingIndexed(current);

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
      await ensureFundingIndexed(log.blockNumber ?? current);
      const fundingLink = resolveFundingLink(publisher);
      const verdict = decide(
        { campaignId: cid, publisher, nullifier, evidenceHash },
        event,
        binding,
        config.verification,
        prior,
        fundingLink,
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
      const linkNote =
        !approved && verdict.reason === "LINKED_PUBLISHER" && fundingLink
          ? ` [${publisher.slice(0, 10)}... linked to ${fundingLink.counterparty.slice(0, 10)}...` +
            `${fundingLink.hops === 1 ? " (funded directly)" : ` (shared funder ${fundingLink.via?.slice(0, 10)}...)`}]`
          : "";
      console.log(
        `claim ${claimId}: ${approved ? "VERIFIED" : `REJECTED(${!approved ? verdict.reason : ""})`} tx=${hash.slice(0, 14)}...${linkNote}`,
      );
    }
  } catch (err) {
    console.error("verifier loop error:", (err as Error).message);
  } finally {
    ticking = false;
  }
}, 2_000);
