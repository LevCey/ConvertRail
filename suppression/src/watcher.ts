import type { Hex } from "viem";
import type { SuppressionStore } from "./store.ts";
import type { SuppressionPlatform, VerifiedClaim } from "./types.ts";

/**
 * Chain intake for the suppression module.
 *
 * Separated from the process wiring so the two things that only go wrong under
 * failure — losing claims across a restart, and unbounded intake — can be
 * tested without a chain.
 *
 * The ordering rule that makes recovery work: an intent for every claim in a
 * block range is on disk *before* the cursor moves past that range. Those
 * blocks are never scanned again, so anything discovered and not persisted is
 * lost permanently. Persisting first turns the journal into the queue's backing
 * store, which is why intake can be bounded without dropping work.
 */

export interface ClaimEventLog {
  claimId: string;
  blockNumber: bigint;
}

export interface ChainReader {
  currentBlock(): Promise<bigint>;
  verifiedIn(from: bigint, to: bigint): Promise<ClaimEventLog[]>;
  disputedIn(from: bigint, to: bigint): Promise<ClaimEventLog[]>;
  /** `null` when the claim belongs to another campaign. */
  claimEvidence(claimId: string): Promise<{ campaignId: string; evidenceHash: Hex } | null>;
}

export interface WatcherOptions {
  store: SuppressionStore;
  reader: ChainReader;
  campaignId: string;
  platform: SuppressionPlatform;
  process: (claim: VerifiedClaim) => Promise<unknown>;
  /** Claims worked on at once. */
  maxInFlight?: number;
  /** Claims held in memory awaiting a worker. Everything beyond this stays on
   * disk and is picked up by a later refill, never dropped. */
  maxPending?: number;
  now?: () => number;
  onError?: (error: Error, context: string) => void;
}

export interface PollResult {
  /** True when a poll was already running and this one stood down. */
  skipped: boolean;
  scannedTo: bigint;
  discovered: number;
  amended: number;
}

export class SuppressionWatcher {
  readonly #options: Required<Omit<WatcherOptions, "onError">> & {
    onError: (error: Error, context: string) => void;
  };
  readonly #queued = new Set<string>();
  /**
   * Claims this process has already handed to the runner.
   *
   * The refill reads the journal, and a claim that failed is still unfinished
   * there — so without this the watcher would hand it back immediately, and
   * again, spinning on a claim that cannot succeed. Retries within a claim are
   * the runner's job, bounded by its attempt budget; retrying across processes
   * is what `resume()` is for. The watcher itself attempts each claim once.
   */
  readonly #attempted = new Set<string>();
  #pending: VerifiedClaim[] = [];
  #inFlight = 0;
  #polling = false;
  #lastBlock: bigint | null = null;

  constructor(options: WatcherOptions) {
    this.#options = {
      maxInFlight: 4,
      maxPending: 256,
      now: Date.now,
      onError: () => {},
      ...options,
    };
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  get inFlightCount(): number {
    return this.#inFlight;
  }

  /**
   * Pick up claims recorded but never finished.
   *
   * The case this exists for: the process died after the cursor advanced past
   * the block that produced the claim. Nothing will ever rescan that block, so
   * without reading the journal back the claim is simply forgotten — a buyer
   * the advertiser was told would be submitted, silently dropped.
   */
  resume(): number {
    const { store, campaignId, platform } = this.#options;
    const unfinished = store.unfinished(campaignId, platform);
    for (const intent of unfinished) {
      this.#enqueue({
        campaignId: intent.campaignId as Hex,
        claimId: intent.claimId,
        evidenceHash: intent.evidenceHash as Hex,
        verifiedAtBlock: intent.verifiedAtBlock,
      });
    }
    void this.#drain();
    return unfinished.length;
  }

  /** Where the next scan starts, from the persisted cursor or the chain head. */
  async start(): Promise<bigint> {
    const { store, campaignId, reader } = this.#options;
    this.#lastBlock = store.readCursor(campaignId) ?? (await reader.currentBlock());
    return this.#lastBlock;
  }

  /**
   * One scan.
   *
   * Re-entrant calls stand down rather than queue up. A slow scan overlapping
   * itself would read the same range twice concurrently and race on the cursor,
   * and a timer that fires faster than the work completes is a normal
   * condition, not an exceptional one.
   */
  async poll(): Promise<PollResult> {
    if (this.#polling) {
      return { skipped: true, scannedTo: this.#lastBlock ?? 0n, discovered: 0, amended: 0 };
    }
    this.#polling = true;
    try {
      return await this.#scan();
    } finally {
      this.#polling = false;
    }
  }

  async #scan(): Promise<PollResult> {
    const { store, reader, campaignId, platform } = this.#options;
    if (this.#lastBlock === null) await this.start();
    const from = (this.#lastBlock as bigint) + 1n;
    const current = await reader.currentBlock();
    if (current < from) {
      return { skipped: false, scannedTo: this.#lastBlock as bigint, discovered: 0, amended: 0 };
    }

    const [verified, disputed] = await Promise.all([
      reader.verifiedIn(from, current),
      reader.disputedIn(from, current),
    ]);

    let discovered = 0;
    for (const log of verified) {
      const evidence = await reader.claimEvidence(log.claimId);
      if (!evidence || evidence.campaignId !== campaignId) continue;
      const intent = {
        type: "intent" as const,
        at: new Date(this.#options.now()).toISOString(),
        campaignId,
        claimId: log.claimId,
        evidenceHash: evidence.evidenceHash,
        platform,
        verifiedAtBlock: log.blockNumber.toString(),
      };
      if (store.recordIntent(intent)) discovered++;
    }

    let amended = 0;
    for (const log of disputed) {
      if (this.#recordAmendment(log)) amended++;
    }

    // Only now. Every intent above is durable, so a crash on the next line
    // costs a rescan at worst, never a claim.
    this.#lastBlock = current;
    store.writeCursor(campaignId, current);

    this.#refill();
    void this.#drain();
    return { skipped: false, scannedTo: current, discovered, amended };
  }

  /**
   * A dispute is recorded and nothing else happens.
   *
   * Removing a buyer from an exclusion audience because a claim was contested
   * would restart advertising to them on the strength of an unresolved
   * objection, which no advertiser asked for. Any receipt already issued stays
   * true: it says the buyer was submitted, and the dispute does not change that.
   */
  #recordAmendment(log: ClaimEventLog): boolean {
    const { store, campaignId, platform } = this.#options;
    if (!store.known(campaignId, log.claimId, platform)) return false;
    store.append({
      type: "transition",
      at: new Date(this.#options.now()).toISOString(),
      campaignId,
      claimId: log.claimId,
      platform,
      state: "AMENDED",
      attempt: 0,
      failure: { permanent: false, code: `DISPUTED_AT_BLOCK_${log.blockNumber}` },
    });
    return true;
  }

  /** Top the in-memory queue back up from the journal, up to the bound. */
  #refill(): void {
    const { store, campaignId, platform, maxPending } = this.#options;
    if (this.#pending.length >= maxPending) return;
    for (const intent of store.unfinished(campaignId, platform)) {
      if (this.#pending.length >= maxPending) break;
      this.#enqueue({
        campaignId: intent.campaignId as Hex,
        claimId: intent.claimId,
        evidenceHash: intent.evidenceHash as Hex,
        verifiedAtBlock: intent.verifiedAtBlock,
      });
    }
  }

  #enqueue(claim: VerifiedClaim): void {
    const key = `${claim.campaignId}:${claim.claimId}`;
    if (this.#queued.has(key) || this.#attempted.has(key)) return;
    if (this.#pending.length >= this.#options.maxPending) return;
    this.#queued.add(key);
    this.#pending.push(claim);
  }

  async #drain(): Promise<void> {
    while (this.#pending.length > 0 && this.#inFlight < this.#options.maxInFlight) {
      const claim = this.#pending.shift();
      if (!claim) break;
      this.#inFlight++;
      this.#attempted.add(`${claim.campaignId}:${claim.claimId}`);
      void this.#options
        .process(claim)
        .catch((error: Error) => {
          // Never propagates into the scan loop: a claim that cannot be
          // suppressed must not stop the loop that is also recording disputes.
          this.#options.onError(error, `claim ${claim.claimId}`);
        })
        .finally(() => {
          this.#inFlight--;
          this.#queued.delete(`${claim.campaignId}:${claim.claimId}`);
          this.#refill();
          void this.#drain();
        });
    }
  }

  /**
   * Settle everything currently outstanding. Bounded, so a queue that refuses
   * to drain surfaces as a failure rather than as a process that never returns.
   */
  async idle(timeoutMs = 30_000): Promise<void> {
    const deadline = this.#options.now() + timeoutMs;
    while (this.#inFlight > 0 || this.#pending.length > 0) {
      if (this.#options.now() > deadline) {
        throw new Error(
          `suppression watcher did not drain: ${this.#pending.length} pending, ${this.#inFlight} in flight`,
        );
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}
