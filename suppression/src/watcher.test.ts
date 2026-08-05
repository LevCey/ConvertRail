import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Hex } from "viem";
import { SuppressionStore } from "./store.ts";
import { SuppressionWatcher, type ChainReader, type ClaimEventLog } from "./watcher.ts";
import type { VerifiedClaim } from "./types.ts";

const CAMPAIGN = `0x${"ab".repeat(32)}`;
const OTHER_CAMPAIGN = `0x${"ff".repeat(32)}`;

const roots: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "convertrail-watcher-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

interface FakeChain extends ChainReader {
  head: bigint;
  verified: ClaimEventLog[];
  disputed: ClaimEventLog[];
  foreign: Set<string>;
  evidenceReads: number;
  verifiedCalls: Array<[bigint, bigint]>;
}

function fakeChain(overrides: Partial<Pick<FakeChain, "head" | "verified" | "disputed">> = {}): FakeChain {
  const chain: FakeChain = {
    head: overrides.head ?? 0n,
    verified: overrides.verified ?? [],
    disputed: overrides.disputed ?? [],
    foreign: new Set<string>(),
    evidenceReads: 0,
    verifiedCalls: [],
    currentBlock: async () => chain.head,
    verifiedIn: async (from, to) => {
      chain.verifiedCalls.push([from, to]);
      return chain.verified.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
    },
    disputedIn: async (from, to) =>
      chain.disputed.filter((l) => l.blockNumber >= from && l.blockNumber <= to),
    claimEvidence: async (claimId) => {
      chain.evidenceReads++;
      return {
        campaignId: chain.foreign.has(claimId) ? OTHER_CAMPAIGN : CAMPAIGN,
        evidenceHash: `0x${claimId.padStart(2, "0").repeat(32).slice(0, 64)}` as Hex,
      };
    },
  };
  return chain;
}

interface Harness {
  watcher: SuppressionWatcher;
  store: SuppressionStore;
  chain: FakeChain;
  processed: string[];
  concurrentPeak: number;
  dir: string;
}

function harness(options: {
  chain?: FakeChain;
  dir?: string;
  maxInFlight?: number;
  maxPending?: number;
  onProcess?: (claim: VerifiedClaim) => Promise<void>;
  finishReceipt?: boolean;
} = {}): Harness {
  const dir = options.dir ?? freshDir();
  const chain = options.chain ?? fakeChain();
  const store = new SuppressionStore(dir);
  const processed: string[] = [];
  const state = { live: 0, peak: 0 };

  const watcher = new SuppressionWatcher({
    store,
    reader: chain,
    campaignId: CAMPAIGN,
    platform: "mock",
    maxInFlight: options.maxInFlight ?? 4,
    maxPending: options.maxPending ?? 256,
    process: async (claim) => {
      state.live++;
      state.peak = Math.max(state.peak, state.live);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        if (options.onProcess) await options.onProcess(claim);
        processed.push(claim.claimId);
        if (options.finishReceipt !== false) markFinished(store, claim);
      } finally {
        state.live--;
      }
    },
  });

  return {
    watcher,
    store,
    chain,
    processed,
    dir,
    get concurrentPeak() {
      return state.peak;
    },
  };
}

/** Stand-in for the runner reaching a signed receipt, which is what takes a
 * claim off the unfinished list. */
function markFinished(store: SuppressionStore, claim: VerifiedClaim): void {
  store.append({
    type: "transition",
    at: new Date().toISOString(),
    campaignId: claim.campaignId,
    claimId: claim.claimId,
    platform: "mock",
    state: "RECEIPT_SIGNED",
    attempt: 1,
  });
}

function logs(count: number, startBlock = 10n): ClaimEventLog[] {
  return Array.from({ length: count }, (_, i) => ({
    claimId: String(i + 1),
    blockNumber: startBlock + BigInt(i),
  }));
}

test("every discovered intent is on disk before the cursor moves", async () => {
  const chain = fakeChain({ verified: logs(3) });
  const h = harness({ chain, onProcess: async () => {} });
  await h.watcher.start();
  chain.head = 100n;

  const writes: string[] = [];
  const realCursor = h.store.writeCursor.bind(h.store);
  h.store.writeCursor = (campaignId, block) => {
    writes.push(`cursor:${block}`);
    realCursor(campaignId, block);
  };
  const realIntent = h.store.recordIntent.bind(h.store);
  h.store.recordIntent = (intent) => {
    const created = realIntent(intent);
    if (created) writes.push(`intent:${intent.claimId}`);
    return created;
  };

  await h.watcher.poll();
  assert.deepEqual(writes, ["intent:1", "intent:2", "intent:3", "cursor:100"]);
});

test("more claims than the in-flight width are all processed, none concurrently beyond it", async () => {
  const chain = fakeChain({ verified: logs(10) });
  const h = harness({ chain, maxInFlight: 4 });
  await h.watcher.start();
  chain.head = 100n;
  await h.watcher.poll();
  await h.watcher.idle();

  assert.equal(h.processed.length, 10);
  assert.deepEqual([...h.processed].sort((a, b) => Number(a) - Number(b)).join(","), "1,2,3,4,5,6,7,8,9,10");
  assert.equal(h.concurrentPeak <= 4, true, `peak concurrency ${h.concurrentPeak} exceeded the bound`);
  assert.equal(h.concurrentPeak > 1, true, "the bound should not have serialised everything");
});

test("intake beyond the pending bound is held on disk, not dropped", async () => {
  const chain = fakeChain({ verified: logs(12) });
  const h = harness({ chain, maxInFlight: 2, maxPending: 3 });
  await h.watcher.start();
  chain.head = 100n;
  await h.watcher.poll();

  // Every claim is durable immediately, regardless of what the queue could hold.
  assert.equal(h.store.unfinished(CAMPAIGN, "mock").length, 12);
  await h.watcher.idle();
  assert.equal(h.processed.length, 12);
  assert.equal(h.store.unfinished(CAMPAIGN, "mock").length, 0);
});

test("a crash after the cursor advanced does not lose the claims it covered", async () => {
  const dir = freshDir();
  const chain = fakeChain({ verified: logs(5) });

  // First process: discovers and persists, then dies before doing any work.
  const crashed = harness({ chain, dir, onProcess: async () => { throw new Error("killed"); }, finishReceipt: false });
  await crashed.watcher.start();
  chain.head = 100n;
  await crashed.watcher.poll();
  await crashed.watcher.idle();
  assert.equal(crashed.processed.length, 0);
  assert.equal(crashed.store.readCursor(CAMPAIGN), 100n);

  // Second process: the blocks are behind the cursor and are never rescanned,
  // so recovery has to come from the journal.
  const restarted = harness({ chain: fakeChain({ head: 100n }), dir });
  const startBlock = await restarted.watcher.start();
  assert.equal(startBlock, 100n, "the cursor is trusted, so those blocks are not rescanned");
  const recovered = restarted.watcher.resume();
  await restarted.watcher.idle();

  assert.equal(recovered, 5);
  assert.equal(restarted.processed.length, 5);
  assert.equal(restarted.chain.verifiedCalls.length, 0, "recovery must not depend on a rescan");
});

test("resume ignores claims that already reached a receipt", async () => {
  const dir = freshDir();
  const chain = fakeChain({ verified: logs(4) });
  const first = harness({ chain, dir });
  await first.watcher.start();
  chain.head = 100n;
  await first.watcher.poll();
  await first.watcher.idle();
  assert.equal(first.processed.length, 4);

  const restarted = harness({ chain: fakeChain({ head: 100n }), dir });
  await restarted.watcher.start();
  assert.equal(restarted.watcher.resume(), 0);
  await restarted.watcher.idle();
  assert.equal(restarted.processed.length, 0);
});

test("a partially finished run resumes only what is unfinished", async () => {
  const dir = freshDir();
  const chain = fakeChain({ verified: logs(6) });
  const first = harness({
    chain,
    dir,
    maxInFlight: 1,
    onProcess: async (claim) => {
      if (Number(claim.claimId) > 2) throw new Error("killed");
    },
  });
  await first.watcher.start();
  chain.head = 100n;
  await first.watcher.poll();
  await first.watcher.idle();
  assert.deepEqual(first.processed, ["1", "2"]);

  const restarted = harness({ chain: fakeChain({ head: 100n }), dir });
  await restarted.watcher.start();
  assert.equal(restarted.watcher.resume(), 4);
  await restarted.watcher.idle();
  assert.deepEqual([...restarted.processed].sort(), ["3", "4", "5", "6"]);
});

test("an overlapping poll stands down instead of racing the cursor", async () => {
  const chain = fakeChain({ verified: logs(2) });
  const h = harness({ chain });
  await h.watcher.start();
  chain.head = 100n;

  let unblock = () => {};
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  chain.currentBlock = async () => {
    await gate;
    return chain.head;
  };

  const first = h.watcher.poll();
  const second = await h.watcher.poll();
  assert.equal(second.skipped, true, "the second poll must stand down");

  unblock();
  const firstResult = await first;
  assert.equal(firstResult.skipped, false);
  assert.equal(firstResult.discovered, 2);
  await h.watcher.idle();
  assert.equal(h.processed.length, 2);
});

test("a rescanned range costs nothing and creates no duplicate work", async () => {
  const dir = freshDir();
  const chain = fakeChain({ verified: logs(3) });
  const h = harness({ chain, dir });
  await h.watcher.start();
  chain.head = 100n;
  const first = await h.watcher.poll();
  await h.watcher.idle();

  // Rewind the cursor as a crash-before-write would leave it.
  h.store.writeCursor(CAMPAIGN, 0n);
  const rewound = harness({ chain: fakeChain({ head: 100n, verified: logs(3) }), dir });
  await rewound.watcher.start();
  const second = await rewound.watcher.poll();
  await rewound.watcher.idle();

  assert.equal(first.discovered, 3);
  assert.equal(second.discovered, 0, "already-recorded intents are not rediscovered");
  assert.equal(rewound.processed.length, 0, "and no work is repeated");
});

test("claims belonging to another campaign are ignored", async () => {
  const chain = fakeChain({ verified: logs(3) });
  chain.foreign.add("2");
  const h = harness({ chain });
  await h.watcher.start();
  chain.head = 100n;
  const result = await h.watcher.poll();
  await h.watcher.idle();

  assert.equal(result.discovered, 2);
  assert.deepEqual([...h.processed].sort(), ["1", "3"]);
});

test("a dispute is recorded as an amendment and starts no work", async () => {
  const chain = fakeChain({ verified: logs(2), disputed: [{ claimId: "1", blockNumber: 12n }] });
  const h = harness({ chain });
  await h.watcher.start();
  chain.head = 100n;
  await h.watcher.poll();
  await h.watcher.idle();

  const amendments = h.store
    .records()
    .filter((r) => r.type === "transition" && r.state === "AMENDED");
  assert.equal(amendments.length, 1);
  assert.equal(h.processed.filter((id) => id === "1").length, 1, "no extra pass for the dispute");
});

test("a dispute for a claim we never took on is not recorded", async () => {
  const chain = fakeChain({ disputed: [{ claimId: "99", blockNumber: 12n }] });
  const h = harness({ chain });
  await h.watcher.start();
  chain.head = 100n;
  const result = await h.watcher.poll();
  assert.equal(result.amended, 0);
  assert.equal(h.store.records().length, 0);
});

test("no scan happens when the chain has not advanced", async () => {
  const chain = fakeChain({ head: 100n, verified: logs(1) });
  const h = harness({ chain });
  await h.watcher.start();
  const result = await h.watcher.poll();
  assert.equal(result.discovered, 0, "start pinned the cursor to the head");
  assert.equal(chain.verifiedCalls.length, 0);
});

test("the cursor is honoured on restart rather than jumping to the head", async () => {
  const dir = freshDir();
  const store = new SuppressionStore(dir);
  store.writeCursor(CAMPAIGN, 42n);
  const h = harness({ chain: fakeChain({ head: 100n, verified: logs(2, 43n) }), dir });
  const startBlock = await h.watcher.start();
  assert.equal(startBlock, 42n);
  const result = await h.watcher.poll();
  assert.equal(result.discovered, 2);
  assert.deepEqual(h.chain.verifiedCalls, [[43n, 100n]]);
});
