// Server-side data layer: reads the campaign's on-chain state + events and
// aggregates them into a serializable DashboardState. Every field is backed by
// chain state (R11.4). Events are cached per campaign and only the un-scanned
// block tail is re-queried on each poll (cheap steady state).
import type { Address, Hex } from "viem";
import {
  ADDRESSES,
  campaignEscrowAbi,
  campaignIdFromName,
  campaignName,
  conversionRegistryAbi,
  publicClient,
  reconstructFraudLog,
  type RejectedEventArgs,
  type SubmittedEventArgs,
} from "./contracts";

const DEFAULT_LOOKBACK = 300_000n;

interface RawLog<A> {
  args: A;
  blockNumber: bigint;
  transactionHash: Hex;
}

interface CampaignCache {
  campaignId: Hex;
  fromBlock: bigint;
  lastScanned: bigint;
  submitted: RawLog<SubmittedEventArgs>[];
  verified: RawLog<{ claimId: bigint; publisher: Address }>[];
  rejected: RawLog<RejectedEventArgs>[];
  settled: RawLog<{ claimId: bigint; publisher: Address }>[];
  recognized: RawLog<{ claimId: bigint; publisher: Address; amount: bigint }>[];
  reallocated: RawLog<{
    fromPublisher: Address;
    toPublisher: Address;
    amount: bigint;
    reasonCode: Hex;
    newFromCap: bigint;
    newToCap: bigint;
  }>[];
  enrolled: RawLog<{ publisher: Address; cap: bigint }>[];
}

const cache = new Map<Hex, CampaignCache>();

async function startFromBlock(): Promise<bigint> {
  if (process.env.CAMPAIGN_FROM_BLOCK) return BigInt(process.env.CAMPAIGN_FROM_BLOCK);
  const current = await publicClient().getBlockNumber();
  return current > DEFAULT_LOOKBACK ? current - DEFAULT_LOOKBACK : 0n;
}

// Effective chain head — optionally capped by CAMPAIGN_TO_BLOCK so a finished
// campaign can be viewed over a bounded window instead of scanning the empty
// gap up to the live head (unset in production: scans to head for live data).
async function effectiveCurrent(): Promise<bigint> {
  const cur = await publicClient().getBlockNumber();
  if (process.env.CAMPAIGN_TO_BLOCK) {
    const cap = BigInt(process.env.CAMPAIGN_TO_BLOCK);
    return cur < cap ? cur : cap;
  }
  return cur;
}

async function scanChunk(campaignId: Hex, fromBlock: bigint, toBlock: bigint): Promise<Required<Pick<CampaignCache, "submitted" | "verified" | "rejected" | "settled" | "recognized" | "reallocated" | "enrolled">>> {
  const pub = publicClient();
  const reg = { address: ADDRESSES.conversionRegistry, abi: conversionRegistryAbi } as const;
  const esc = { address: ADDRESSES.campaignEscrow, abi: campaignEscrowAbi } as const;
  const range = { fromBlock, toBlock } as const;

  const [submitted, verified, rejected, settled, recognized, reallocated, enrolled] = await Promise.all([
    pub.getContractEvents({ ...reg, eventName: "ClaimSubmitted", args: { campaignId }, ...range }),
    pub.getContractEvents({ ...reg, eventName: "ClaimVerified", args: { campaignId }, ...range }),
    pub.getContractEvents({ ...reg, eventName: "ClaimRejected", args: { campaignId }, ...range }),
    pub.getContractEvents({ ...reg, eventName: "ClaimSettled", args: { campaignId }, ...range }),
    pub.getContractEvents({ ...esc, eventName: "PayoutRecognized", args: { campaignId }, ...range }),
    pub.getContractEvents({ ...esc, eventName: "BudgetReallocated", args: { campaignId }, ...range }),
    pub.getContractEvents({ ...esc, eventName: "PublisherEnrolled", args: { campaignId }, ...range }),
  ]);

  const map = <A>(logs: readonly { args: unknown; blockNumber: bigint | null; transactionHash: Hex | null }[]): RawLog<A>[] =>
    logs.map((l) => ({ args: l.args as A, blockNumber: l.blockNumber ?? 0n, transactionHash: l.transactionHash ?? ("0x" as Hex) }));

  return {
    submitted: map(submitted),
    verified: map(verified),
    rejected: map(rejected),
    settled: map(settled),
    recognized: map(recognized),
    reallocated: map(reallocated),
    enrolled: map(enrolled),
  };
}

// The public RPC caps eth_getLogs at a 10,000-block range, so scan in
// <=9,000-block windows (event types parallel per window, windows sequential).
async function scanRange(campaignId: Hex, fromBlock: bigint, toBlock: bigint): Promise<Required<Pick<CampaignCache, "submitted" | "verified" | "rejected" | "settled" | "recognized" | "reallocated" | "enrolled">>> {
  const acc = { submitted: [], verified: [], rejected: [], settled: [], recognized: [], reallocated: [], enrolled: [] } as Awaited<ReturnType<typeof scanChunk>>;
  if (fromBlock > toBlock) return acc;
  const CHUNK = 9_000n;
  for (let start = fromBlock; start <= toBlock; start += CHUNK + 1n) {
    const end = start + CHUNK < toBlock ? start + CHUNK : toBlock;
    const c = await scanChunk(campaignId, start, end);
    acc.submitted.push(...c.submitted);
    acc.verified.push(...c.verified);
    acc.rejected.push(...c.rejected);
    acc.settled.push(...c.settled);
    acc.recognized.push(...c.recognized);
    acc.reallocated.push(...c.reallocated);
    acc.enrolled.push(...c.enrolled);
  }
  return acc;
}

async function refresh(campaignId: Hex): Promise<CampaignCache> {
  const current = await effectiveCurrent();
  let entry = cache.get(campaignId);

  if (!entry) {
    const fromBlock = await startFromBlock();
    entry = {
      campaignId,
      fromBlock,
      lastScanned: fromBlock - 1n,
      submitted: [], verified: [], rejected: [], settled: [], recognized: [], reallocated: [], enrolled: [],
    };
    cache.set(campaignId, entry);
  }

  if (current > entry.lastScanned) {
    const delta = await scanRange(campaignId, entry.lastScanned + 1n, current);
    entry.submitted.push(...(delta.submitted ?? []));
    entry.verified.push(...(delta.verified ?? []));
    entry.rejected.push(...(delta.rejected ?? []));
    entry.settled.push(...(delta.settled ?? []));
    entry.recognized.push(...(delta.recognized ?? []));
    entry.reallocated.push(...(delta.reallocated ?? []));
    entry.enrolled.push(...(delta.enrolled ?? []));
    entry.lastScanned = current; // advance only after a fully successful scan
  }
  return entry;
}

// --- Serializable output shape ---
export interface DashboardState {
  campaignName: string;
  campaignId: Hex;
  currentBlock: string;
  exists: boolean;
  campaign: {
    advertiser: Address;
    operationalWallet: Address;
    pricePerConversion: string;
    budget: string;
    recognizedTotal: string;
    reimbursedTotal: string;
    remaining: string;
    disputeWindowBlocks: number;
  } | null;
  publishers: {
    address: Address;
    cap: string;
    recognized: string;
    verified: number;
    rejected: number;
    settled: number;
    qualityPct: number | null;
  }[];
  feed: { claimId: string; publisher: Address; amount: string; txHash: Hex; blockNumber: string }[];
  fraudLog: { claimId: string; publisher: Address; nullifier: Hex; evidenceHash: Hex; reason: string }[];
  reallocations: {
    from: Address; to: Address; amount: string; reason: string; newFromCap: string; newToCap: string; txHash: Hex; blockNumber: string;
  }[];
  pending: { claimId: string; publisher: Address; settleAtBlock: string; blocksLeft: number }[];
  counters: { txCount: number; settled: number; verified: number; rejected: number; reallocations: number };
}

function decodeReason(reasonCode: Hex): string {
  try {
    const bytes = reasonCode.slice(2).replace(/(00)+$/, "");
    const str = Buffer.from(bytes, "hex").toString("utf8");
    return str || reasonCode;
  } catch {
    return reasonCode;
  }
}

export async function getDashboardState(name?: string): Promise<DashboardState> {
  const cName = name ?? campaignName();
  const campaignId = campaignIdFromName(cName);
  const pub = publicClient();
  const c = await refresh(campaignId);
  const currentBlock = await effectiveCurrent();

  const campaignRaw = await pub
    .readContract({ address: ADDRESSES.campaignEscrow, abi: campaignEscrowAbi, functionName: "getCampaign", args: [campaignId] })
    .catch(() => null);
  const exists = !!campaignRaw && campaignRaw.budget > 0n;

  // Per-publisher aggregation
  const pubAddrs = new Map<string, Address>();
  for (const e of c.enrolled) pubAddrs.set(e.args.publisher.toLowerCase(), e.args.publisher);
  const countBy = (logs: RawLog<{ publisher: Address }>[]) => {
    const m = new Map<string, number>();
    for (const l of logs) m.set(l.args.publisher.toLowerCase(), (m.get(l.args.publisher.toLowerCase()) ?? 0) + 1);
    return m;
  };
  const verifiedBy = countBy(c.verified);
  const rejectedBy = countBy(c.rejected);
  const settledBy = countBy(c.settled);

  const publishers = await Promise.all(
    [...pubAddrs.values()].map(async (address) => {
      const alloc = await pub
        .readContract({ address: ADDRESSES.campaignEscrow, abi: campaignEscrowAbi, functionName: "getAllocation", args: [campaignId, address] })
        .catch(() => null);
      const key = address.toLowerCase();
      const v = verifiedBy.get(key) ?? 0;
      const r = rejectedBy.get(key) ?? 0;
      return {
        address,
        cap: (alloc?.cap ?? 0n).toString(),
        recognized: (alloc?.recognized ?? 0n).toString(),
        verified: v,
        rejected: r,
        settled: settledBy.get(key) ?? 0,
        qualityPct: v + r > 0 ? Math.round((v / (v + r)) * 100) : null,
      };
    }),
  );

  const feed = c.recognized
    .map((l) => ({
      claimId: l.args.claimId.toString(),
      publisher: l.args.publisher,
      amount: l.args.amount.toString(),
      txHash: l.transactionHash,
      blockNumber: l.blockNumber.toString(),
    }))
    .sort((a, b) => Number(BigInt(b.claimId) - BigInt(a.claimId)));

  const fraudLog = reconstructFraudLog(
    c.submitted.map((l) => l.args),
    c.rejected.map((l) => l.args),
  ).map((e) => ({
    claimId: e.claimId.toString(),
    publisher: e.publisher,
    nullifier: e.nullifier,
    evidenceHash: e.evidenceHash,
    reason: e.reason,
  }));

  const reallocations = c.reallocated
    .map((l) => ({
      from: l.args.fromPublisher,
      to: l.args.toPublisher,
      amount: l.args.amount.toString(),
      reason: decodeReason(l.args.reasonCode),
      newFromCap: l.args.newFromCap.toString(),
      newToCap: l.args.newToCap.toString(),
      txHash: l.transactionHash,
      blockNumber: l.blockNumber.toString(),
    }))
    .sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)));

  // Pending = VERIFIED and not yet SETTLED/recognized → auto-settle countdown
  const window = campaignRaw ? BigInt(campaignRaw.disputeWindowBlocks) : 0n;
  const settledIds = new Set<string>([
    ...c.settled.map((l) => l.args.claimId.toString()),
    ...c.recognized.map((l) => l.args.claimId.toString()),
  ]);
  const pending = c.verified
    .filter((l) => !settledIds.has(l.args.claimId.toString()))
    .map((l) => {
      const settleAt = l.blockNumber + window;
      return {
        claimId: l.args.claimId.toString(),
        publisher: l.args.publisher,
        settleAtBlock: settleAt.toString(),
        blocksLeft: Number(settleAt - currentBlock),
      };
    })
    .sort((a, b) => a.blocksLeft - b.blocksLeft);

  const txHashes = new Set<string>();
  for (const group of [c.submitted, c.verified, c.rejected, c.settled, c.recognized, c.reallocated]) {
    for (const l of group) txHashes.add(l.transactionHash);
  }

  return {
    campaignName: cName,
    campaignId,
    currentBlock: currentBlock.toString(),
    exists,
    campaign: exists && campaignRaw
      ? {
          advertiser: campaignRaw.advertiser,
          operationalWallet: campaignRaw.operationalWallet,
          pricePerConversion: campaignRaw.pricePerConversion.toString(),
          budget: campaignRaw.budget.toString(),
          recognizedTotal: campaignRaw.recognizedTotal.toString(),
          reimbursedTotal: campaignRaw.reimbursedTotal.toString(),
          remaining: (campaignRaw.budget - campaignRaw.recognizedTotal).toString(),
          disputeWindowBlocks: Number(campaignRaw.disputeWindowBlocks),
        }
      : null,
    publishers: publishers.sort((a, b) => Number(BigInt(b.recognized) - BigInt(a.recognized))),
    feed,
    fraudLog,
    reallocations,
    pending,
    counters: {
      txCount: txHashes.size,
      settled: c.recognized.length,
      verified: c.verified.length,
      rejected: c.rejected.length,
      reallocations: c.reallocated.length,
    },
  };
}
