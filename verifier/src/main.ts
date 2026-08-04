// Chain adapter around the pure decision core: watches ClaimSubmitted,
// fetches evidence from the merchant source by hash, posts verdicts on-chain.
// Holds no funds and has no payment capability — separation of duties from
// the settlement module is a trust boundary, not a convention.
import { writeFileSync } from "node:fs";
import { parseAbiItem, type Address, type Hex } from "viem";
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
  transportStats,
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

// Infrastructure has to stay outside that set, and the check is a startup
// assertion rather than a property that happens to hold. These wallets pay
// publishers in the ordinary course of business; if one of them were ever a
// participant, every publisher it paid would resolve as a linked identity and
// the rule would refuse precisely the honest partners it exists to protect.
for (const [label, address] of [
  ["operational wallet", wallets.operational.address],
  ["Gateway payer", process.env.CIRCLE_WALLET_ADDRESS as Address | undefined],
  ["campaign escrow", env.campaignEscrow],
  ["conversion registry", env.conversionRegistry],
] as const) {
  if (address && participants.has(address.toLowerCase() as Address)) {
    console.error(
      `FATAL: ${label} ${address} is inside the campaign participant set. ` +
        `Funding links would then refuse every publisher it pays.`,
    );
    process.exit(1);
  }
}

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

// --- Step profiler --------------------------------------------------------
// Console lines are not evidence: they are lossy, unordered under concurrency,
// and impossible to aggregate. Each step records count/total/max here and the
// whole picture is written to a file, so "what actually costs the 3.8 seconds
// per claim" is answered by measurement rather than by reading the code.
interface StepStat {
  count: number;
  totalMs: number;
  maxMs: number;
}
const profile: Record<string, StepStat> = {};

function record(step: string, ms: number): void {
  const stat = (profile[step] ??= { count: 0, totalMs: 0, maxMs: 0 });
  stat.count++;
  stat.totalMs += ms;
  if (ms > stat.maxMs) stat.maxMs = ms;
}

async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    record(step, Date.now() - startedAt);
  }
}

const fundingIndexStats = { blocksScanned: 0, logsSeen: 0, calls: 0, maxRange: 0 };
/** Block span of the real claim scans, so a chosen getLogs limit can be
 * checked against what the run actually asks for rather than a guess. */
const claimScanStats = { calls: 0, blocksScanned: 0, maxRange: 0 };

// --- Funding graph -------------------------------------------------------
// Identity integrity is resolved from the same public chain anyone else can
// read: who sent value to whom. Arc surfaces value movement as Transfer logs
// from a synthetic emitter, which is both cheaper and more accurate than
// walking full blocks: one ranged eth_getLogs replaces one eth_getBlock per
// block, reverted transfers never appear (walking blocks records them, because
// a transaction object carries its value whether or not it succeeded), and
// value moved by internal calls is included rather than invisible.
/** Blocks per getLogs call. A 10,000-block range was measured to succeed on
 * this RPC; 2,000 keeps each response small enough to stay well inside the
 * request budget while still collapsing a backlog in a few calls. */
const FUNDING_RANGE = 2_000n;

const NATIVE_TRANSFER_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe" as Address;
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

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

/** Claims are decided against a funding index that covers their own block, so
 * a verdict never depends on how far the indexer happened to have run. The
 * cursor advances only after a successful query, so a throttled range is
 * retried rather than skipped — a gap here would be a silent hole in the
 * evidence a refusal rests on. */
async function ensureFundingIndexed(upTo: bigint): Promise<void> {
  while (fundingCursor < upTo) {
    const from = fundingCursor + 1n;
    const to = upTo - from >= FUNDING_RANGE ? from + FUNDING_RANGE - 1n : upTo;
    const logs = await pub.getLogs({
      address: NATIVE_TRANSFER_EMITTER,
      event: transferEvent,
      fromBlock: from,
      toBlock: to,
    });
    fundingIndexStats.calls++;
    const span = Number(to - from + 1n);
    fundingIndexStats.blocksScanned += span;
    if (span > fundingIndexStats.maxRange) fundingIndexStats.maxRange = span;
    fundingIndexStats.logsSeen += logs.length;
    for (const log of logs) {
      const sender = log.args.from?.toLowerCase();
      const recipient = log.args.to?.toLowerCase();
      if (!sender || !recipient || sender === recipient || (log.args.value ?? 0n) === 0n) continue;
      addEdge(fundedBy, recipient, sender);
      addEdge(funded, sender, recipient);
    }
    fundingCursor = to;
  }
}

// --- Verdict pipeline ----------------------------------------------------
// One verdict per transaction, sent and confirmed strictly one at a time, put
// the verifier below the rate claims arrive at: measured 0.127 verdicts/s
// against 0.638 claims/s, with the backlog growing every quarter of the run.
//
// The failure this must not repeat: an earlier attempt detached confirmation
// entirely, which started one receipt poller per transaction. Dozens polling at
// once crossed the RPC's sustained request budget and every component stalled.
// So confirmation is pipelined, not abandoned — a bounded number of sends may
// be outstanding, but exactly one worker confirms them, in order.
const MAX_IN_FLIGHT = Number(process.env.VERIFIER_MAX_IN_FLIGHT ?? 8);
const RECEIPT_TIMEOUT_MS = Number(process.env.VERIFIER_RECEIPT_TIMEOUT_MS ?? 30_000);
/** Minimum gap between verdict sends. The target is 0.766 verdicts/s, so 250 ms
 * (four per second) clears it more than fivefold and still fills a queue of
 * eight — while keeping this component off the public RPC's burst threshold.
 * Faster pacing buys throughput this run does not need and risk it cannot
 * afford. */
const SEND_PACING_MS = Number(process.env.VERIFIER_SEND_PACING_MS ?? 250);
/** Measured, not guessed: across all 173 postVerdict transactions of
 * poc-demo-17, gas used was 39,366 for an approval and 39,915 for a rejection
 * with zero variance inside either class — the call writes a fixed-size
 * struct. 60,000 is the observed maximum plus half again, which covers a
 * structural change without waste, since unused gas is refunded. Supplying it
 * removes an eth_estimateGas round trip from every send, and on this endpoint
 * the scarce resource is requests, not gas. */
const VERDICT_GAS_LIMIT = BigInt(process.env.VERIFIER_GAS_LIMIT ?? 60_000);
/** Fee data is refreshed on a timer instead of per transaction, for the same
 * reason. Headroom is doubled so a base-fee rise inside the window cannot
 * underprice a send. */
const FEE_TTL_MS = Number(process.env.VERIFIER_FEE_TTL_MS ?? 60_000);
/**
 * Verifier-local nonce.
 *
 * viem 2.55.2's nonce manager re-reads the pending nonce on every send —
 * measured at 185 eth_getTransactionCount calls for 185 sends. That is correct
 * behaviour, and it costs a request each time on an endpoint where requests,
 * not gas, are the scarce resource.
 *
 * SAFETY PRECONDITION: this key must have exactly one writer for the duration
 * of a run. The harness spawns a single verifier and the single-run lock
 * prevents a second harness, so that holds here. It does NOT hold in general,
 * which is why this stays local to the verifier and the shared wallet factory
 * is left alone. The counter advances only after a hash comes back; an
 * uncertain send still aborts the run rather than guessing.
 *
 * Expected effect on request volume: per-verdict nonce reads go from one each
 * (185 in poc-demo-18) to zero. The startup seed still costs two
 * eth_getTransactionCount calls — pending and latest, compared to assert sole
 * ownership — so the run total should be 2, not 0.
 */
let nextNonce = 0;

let cachedFees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null = null;
let feesFetchedAt = 0;

async function currentFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  if (cachedFees && Date.now() - feesFetchedAt < FEE_TTL_MS) return cachedFees;
  const est = await timed("feeEstimate", () => pub.estimateFeesPerGas());
  cachedFees = {
    maxFeePerGas: est.maxFeePerGas * 2n,
    maxPriorityFeePerGas: est.maxPriorityFeePerGas,
  };
  feesFetchedAt = Date.now();
  return cachedFees;
}

interface PendingVerdict {
  claimId: bigint;
  hash: Hex;
  sentAt: number;
}

const inFlight: PendingVerdict[] = []; // FIFO: index 0 is the oldest
let receiptWorkerActive = false;
let lastSendAt = 0;
let maxInFlightSeen = 0;
let inFlightSum = 0;
let inFlightSamples = 0;
let maxOldestWaitMs = 0;
let verdictsConfirmed = 0;

/** A verdict that cannot be confirmed is not a slow verdict, it is an unknown
 * one — and an unknown verdict makes every number this run reports unsafe. The
 * verifier is a critical child, so exiting here aborts the whole run rather
 * than letting it finish with a gap nobody can see. Never resend blindly: a
 * duplicate verdict transaction is exactly the corruption being guarded
 * against. */
function abortRun(reason: string): never {
  console.error(`FATAL: ${reason}`);
  process.exit(1);
}

/** Exactly one of these runs at a time, and it confirms in send order. */
async function receiptWorker(): Promise<void> {
  if (receiptWorkerActive) return;
  receiptWorkerActive = true;
  try {
    while (inFlight.length > 0) {
      const oldest = inFlight[0];
      const remaining = RECEIPT_TIMEOUT_MS - (Date.now() - oldest.sentAt);
      if (remaining <= 0) {
        abortRun(
          `verdict for claim ${oldest.claimId} (${oldest.hash}) was not confirmed within ` +
            `${RECEIPT_TIMEOUT_MS}ms — treating it as dropped rather than resending`,
        );
      }
      let receipt;
      const confirmStartedAt = Date.now();
      try {
        receipt = await pub.waitForTransactionReceipt({ hash: oldest.hash, timeout: remaining });
      } catch (err) {
        abortRun(
          `verdict for claim ${oldest.claimId} (${oldest.hash}) could not be confirmed: ` +
            `${(err as Error).message.split("\n")[0]}`,
        );
      }
      if (receipt.status !== "success") {
        abortRun(`verdict for claim ${oldest.claimId} reverted on-chain (${oldest.hash})`);
      }
      record("receiptConfirm", Date.now() - confirmStartedAt);
      const waited = Date.now() - oldest.sentAt;
      if (waited > maxOldestWaitMs) maxOldestWaitMs = waited;
      verdictsConfirmed++;
      inFlight.shift();
    }
  } finally {
    receiptWorkerActive = false;
  }
}

/** Backpressure. The queue is bounded, so a verifier that falls behind stops
 * accepting work instead of growing an unbounded pile of unconfirmed sends. */
async function awaitQueueSpace(): Promise<void> {
  while (inFlight.length >= MAX_IN_FLIGHT) {
    await new Promise((r) => setTimeout(r, 50));
    void receiptWorker();
  }
}

/** Controlled pacing so a drained queue cannot turn into a burst of sends
 * against a rate-limited public endpoint. */
async function paceSend(): Promise<void> {
  const wait = SEND_PACING_MS - (Date.now() - lastSendAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSendAt = Date.now();
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

setInterval(() => {
  writeFileSync(
    ".e2e/verifier-stats.json",
    JSON.stringify(
      {
        maxInFlight: maxInFlightSeen,
        avgInFlight: inFlightSamples > 0 ? Number((inFlightSum / inFlightSamples).toFixed(2)) : 0,
        maxOldestWaitMs,
        verdictsConfirmed,
        stillInFlight: inFlight.length,
        maxInFlightLimit: MAX_IN_FLIGHT,
        sendPacingMs: SEND_PACING_MS,
        pendingClaims: pendingClaims.length,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    ".e2e/verifier-profile.json",
    JSON.stringify(
      {
        steps: Object.fromEntries(
          Object.entries(profile).map(([step, s]) => [
            step,
            { count: s.count, totalMs: s.totalMs, avgMs: Number((s.totalMs / s.count).toFixed(1)), maxMs: s.maxMs },
          ]),
        ),
        fundingIndex: {
          ...fundingIndexStats,
          avgRange: fundingIndexStats.calls ? Math.round(fundingIndexStats.blocksScanned / fundingIndexStats.calls) : 0,
        },
        claimScan: {
          ...claimScanStats,
          avgRange: claimScanStats.calls ? Math.round(claimScanStats.blocksScanned / claimScanStats.calls) : 0,
        },
        transport: { ...transportStats },
      },
      null,
      2,
    ) + "\n",
  );
}, 5_000).unref();

nextNonce = await pub.getTransactionCount({ address: wallet.account.address, blockTag: "pending" });
const confirmedNonce = await pub.getTransactionCount({
  address: wallet.account.address,
  blockTag: "latest",
});
if (nextNonce !== confirmedNonce) {
  console.error(
    `FATAL: verifier wallet ${wallet.account.address} has ${nextNonce - confirmedNonce} pending ` +
      `transaction(s) at startup. A local nonce is only safe with a single writer; something else ` +
      `is using this key.`,
  );
  process.exit(1);
}
console.log(`verifier nonce seeded at ${nextNonce} (sole writer asserted)`);

console.log(`verifier watching from block ${lastBlock} (policy ${localPolicyHash.slice(0, 10)}...)`);

interface PendingClaim {
  claimId: bigint;
  campaignId: Hex;
  publisher: Address;
  nullifier: Hex;
  evidenceHash: Hex;
}

/** Claims discovered but not yet decided. Bounded: when it is full the scan
 * pauses rather than pulling more work, and the chain keeps the backlog — it is
 * the source of truth, this queue is only a work list. */
const pendingClaims: PendingClaim[] = [];
const pendingIds = new Set<bigint>();
const MAX_PENDING = Number(process.env.VERIFIER_MAX_PENDING ?? 400);
/** Wall clock a single tick may spend draining, so scanning cannot starve. */
const DRAIN_BUDGET_MS = Number(process.env.VERIFIER_DRAIN_BUDGET_MS ?? 10_000);

/** Back to the best measured setting. A 3 s tick was tried and the run that
 * used it was slower, but the two runs met different RPC load, so that is an
 * observation rather than a demonstrated cause. A read-only benchmark over a
 * fixed historical window found no width threshold at all — throttling tracked
 * request rate, not query size — so no claim is made here about why. */
const TICK_MS = Number(process.env.VERIFIER_TICK_MS ?? 2_000);

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    // --- scan phase -------------------------------------------------------
    // The cursor advances only after BOTH the log query and the funding index
    // have succeeded for this range. Advancing first, as an earlier version
    // did, means a throttled tick silently skips every claim in the window it
    // already marked as read — the claims are still on chain, but nothing ever
    // looks at them again.
    if (pendingClaims.length < MAX_PENDING) {
      const current = await pub.getBlockNumber();
      if (current > lastBlock) {
        const from = lastBlock + 1n;
        claimScanStats.calls++;
        {
          const span = Number(current - from + 1n);
          claimScanStats.blocksScanned += span;
          if (span > claimScanStats.maxRange) claimScanStats.maxRange = span;
        }
        const logs = await timed("claimLogScan", () =>
          pub.getContractEvents({
            address: env.conversionRegistry,
            abi: conversionRegistryAbi,
            eventName: "ClaimSubmitted",
            fromBlock: from,
            toBlock: current,
          }),
        );
        // Once per tick for the whole batch. Per-claim indexing was left over
        // from the full-block implementation, where each claim needed its own
        // block; a ranged getLogs covers the entire batch in one call.
        await timed("fundingIndex", () => ensureFundingIndexed(current));

        // Real backpressure, and it has to be whole-block. Accepting part of a
        // block would force the cursor back to that block, and the next scan
        // would re-deliver the claims already queued from it — a duplicate
        // verdict, which is the one corruption this pipeline must not produce.
        // So consume entire blocks while they fit, and leave the rest on chain.
        const room = MAX_PENDING - pendingClaims.length;
        let take = 0;
        let cutoff = from - 1n;
        for (let i = 0; i < logs.length; ) {
          const block = logs[i].blockNumber;
          if (block === null) break;
          let j = i;
          while (j < logs.length && logs[j].blockNumber === block) j++;
          if (take + (j - i) > room) break;
          take = j;
          cutoff = block;
          i = j;
        }
        for (const log of logs.slice(0, take)) {
          const a = log.args as {
            claimId: bigint;
            campaignId: Hex;
            publisher: Address;
            nullifier: Hex;
            evidenceHash: Hex;
          };
          if (pendingIds.has(a.claimId)) continue; // belt and braces against re-delivery
          pendingIds.add(a.claimId);
          pendingClaims.push({
            claimId: a.claimId,
            campaignId: a.campaignId,
            publisher: a.publisher,
            nullifier: a.nullifier,
            evidenceHash: a.evidenceHash,
          });
        }
        // Only as far as fully consumed. Anything beyond stays unread and is
        // rescanned when the queue has room — deferred, never dropped.
        lastBlock = take === logs.length ? current : cutoff;
        if (take < logs.length) {
          console.log(
            `backpressure: queued ${take}/${logs.length} claims, cursor held at ${lastBlock} ` +
              `(pending ${pendingClaims.length}/${MAX_PENDING})`,
          );
        }
      }
    }

    // --- drain phase ------------------------------------------------------
    // A claim leaves the queue only after its verdict transaction is sent. An
    // error anywhere below leaves it at the head, to be retried next tick.
    const drainUntil = Date.now() + DRAIN_BUDGET_MS;
    while (pendingClaims.length > 0 && Date.now() < drainUntil) {
      const claim = pendingClaims[0];
      const nowMs = Date.now();
      const prior = priorClaims(claim.publisher, nowMs);
      const event = await timed("fetchEvent", () => fetchEventByHash(claim.evidenceHash));
      const fundingLink = resolveFundingLink(claim.publisher);
      const verdict = decide(
        {
          campaignId: claim.campaignId,
          publisher: claim.publisher,
          nullifier: claim.nullifier,
          evidenceHash: claim.evidenceHash,
        },
        event,
        binding,
        config.verification,
        prior,
        fundingLink,
      );

      const approved = verdict.approved;
      const reason = approved ? REJECT_REASON.NONE : REJECT_REASON[verdict.reason];
      await timed("queueWait", () => awaitQueueSpace());
      await timed("pacingWait", () => paceSend());
      // A send that throws is not a send that failed: the transaction may have
      // reached the chain with only the response lost. Retrying it next tick
      // would post a second verdict for the same claim, so the run stops here
      // instead. A hash-recovery path would be better and is not needed to be
      // safe — only to be convenient.
      let hash: Hex;
      try {
        const fees = await currentFees();
        hash = await timed("writeContract", () =>
          wallet.writeContract({
            address: env.conversionRegistry,
            abi: conversionRegistryAbi,
            functionName: "postVerdict",
            args: [claim.claimId, approved, reason],
            gas: VERDICT_GAS_LIMIT,
            nonce: nextNonce,
            ...fees,
          }),
        );
        nextNonce++; // only after a hash came back
      } catch (err) {
        abortRun(
          `verdict send for claim ${claim.claimId} returned no hash: ` +
            `${(err as Error).message.split("\n")[0]} — the transaction may still have landed, ` +
            `so it is not retried`,
        );
      }
      // Rate history advances only for a claim that was actually decided and
      // sent. Counting a failed send would change the verdict a retry reaches.
      prior.push(nowMs);
      pendingClaims.shift(); // sent — safe to drop from the work list
      pendingIds.delete(claim.claimId);
      inFlight.push({ claimId: claim.claimId, hash, sentAt: Date.now() });
      if (inFlight.length > maxInFlightSeen) maxInFlightSeen = inFlight.length;
      inFlightSum += inFlight.length;
      inFlightSamples++;
      void receiptWorker();
      const linkNote =
        !approved && verdict.reason === "LINKED_PUBLISHER" && fundingLink
          ? ` [${claim.publisher.slice(0, 10)}... linked to ${fundingLink.counterparty.slice(0, 10)}...` +
            `${fundingLink.hops === 1 ? " (funded directly)" : ` (shared funder ${fundingLink.via?.slice(0, 10)}...)`}]`
          : "";
      console.log(
        `claim ${claim.claimId}: ${approved ? "VERIFIED" : `REJECTED(${!approved ? verdict.reason : ""})`} ` +
          `tx=${hash.slice(0, 14)}... [inflight ${inFlight.length}/${MAX_IN_FLIGHT}, pending ${pendingClaims.length}]${linkNote}`,
      );
    }
  } catch (err) {
    console.error("verifier loop error:", (err as Error).message.split("\n")[0]);
  } finally {
    ticking = false;
  }
}, TICK_MS);
