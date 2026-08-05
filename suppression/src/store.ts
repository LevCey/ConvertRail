import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { canonicalJSON } from "@convertrail/shared";
import { assertSafeToPersist } from "./redaction.ts";
import { emptyState } from "./core.ts";
import type {
  LifecycleState,
  SkipReason,
  SuppressionPlatform,
  SuppressionReceipt,
  SuppressionState,
} from "./types.ts";

/**
 * Append-only journal, replayed on start.
 *
 * Deliberately not `.e2e/`: the demo harness wipes that directory between runs,
 * and a suppression journal that disappears takes the evidence with it. This
 * store is the only record that a buyer was ever submitted, so it outlives the
 * run that produced it.
 *
 * Every record passes the redaction gate before it is written. A record that
 * would leak an identifier throws rather than being cleaned up silently —
 * reaching the store with one means an earlier control failed.
 */

export const STORE_DIR = ".suppression";

export interface IntentRecord {
  type: "intent";
  at: string;
  campaignId: string;
  claimId: string;
  evidenceHash: string;
  platform: SuppressionPlatform;
  verifiedAtBlock: string;
}

export interface TransitionRecord {
  type: "transition";
  at: string;
  campaignId: string;
  claimId: string;
  platform: SuppressionPlatform;
  state: LifecycleState;
  attempt: number;
  /** Set once, on the transition that accepted an authenticated envelope. A
   * keyed HMAC, never the platform's identifier hash. */
  subjectCommitment?: string | undefined;
  envelopeFingerprint?: string | undefined;
  skipReason?: SkipReason | undefined;
  failure?: { permanent: boolean; code: string } | undefined;
  outcome?: unknown;
}

export interface ReceiptRecord {
  type: "receipt";
  at: string;
  receipt: SuppressionReceipt;
}

export interface DeadLetterRecord {
  type: "dead-letter";
  at: string;
  campaignId: string;
  claimId: string;
  platform: SuppressionPlatform;
  code: string;
  attempts: number;
}

export type StoreRecord = IntentRecord | TransitionRecord | ReceiptRecord | DeadLetterRecord;

/**
 * Everything a receipt needs that a crashed process would otherwise have lost.
 *
 * Before this existed, the outcomes list, the acceptance timestamp and the
 * exclusion digest lived only in the runner's local variables. A worker that
 * died after the audience write and restarted would sign a receipt saying
 * `acceptedAt: null` and `exclusionConfigurationHash: "unverified"` while the
 * lifecycle said the work had succeeded — a document that understated what
 * happened and whose response digest covered none of it. Rebuilt from the
 * journal instead.
 */
export interface ClaimProgress {
  outcomes: unknown[];
  audienceAcceptedAt: string | null;
  exclusionDigest: string | null;
  /**
   * The tenant-keyed HMAC over the buyer the platform was actually given,
   * written the moment an authenticated envelope was accepted.
   *
   * Persisted for the same reason as the rest, but the failure it prevents is
   * worse. Recomputing it later needs the envelope, and after a crash the
   * merchant may be gone — which used to leave a fallback commitment derived
   * from the evidence hash. The lifecycle states were already reached, so the
   * receipt still signed as COMPLETED: a completed document bound to a
   * commitment for nobody, over work done for a real buyer. The commitment is
   * evidence, so it is stored when it is proven, not reconstructed on demand.
   */
  subjectCommitment: string | null;
  /** Keyed digest over the envelope fields execution reads. Detects a refetch
   * that changed anything a platform call depends on, not just the buyer id. */
  envelopeFingerprint: string | null;
}

/** Accepts the first proven value and refuses a second, different one. */
function adopt(
  current: string | null,
  incoming: string | undefined,
  what: string,
  record: TransitionRecord,
): string | null {
  if (!incoming) return current;
  if (current !== null && current !== incoming) {
    throw new Error(
      `suppression journal: conflicting ${what} for claim ${record.campaignId}:${record.claimId} ` +
        `on ${record.platform} — the record cannot say which buyer the platform received`,
    );
  }
  return incoming;
}

function emptyProgress(): ClaimProgress {
  return {
    outcomes: [],
    audienceAcceptedAt: null,
    exclusionDigest: null,
    subjectCommitment: null,
    envelopeFingerprint: null,
  };
}

export interface Cursor {
  campaignId: string;
  /** Last block whose events are fully recorded. Advanced per whole block, so a
   * crash mid-block replays that block rather than skipping its remainder. */
  lastScannedBlock: string;
}

function keyOf(campaignId: string, claimId: string, platform: SuppressionPlatform): string {
  return `${campaignId}:${claimId}:${platform}`;
}

export class SuppressionStore {
  readonly #journal: string;
  readonly #cursorPath: string;
  readonly #states = new Map<string, SuppressionState>();
  readonly #receipts = new Map<string, SuppressionReceipt>();
  readonly #intents = new Map<string, IntentRecord>();
  readonly #progress = new Map<string, ClaimProgress>();

  constructor(directory: string = STORE_DIR) {
    mkdirSync(directory, { recursive: true });
    this.#journal = `${directory}/journal.jsonl`;
    this.#cursorPath = `${directory}/cursor.json`;
    this.#replay();
  }

  /**
   * Rebuild in-memory state from the journal.
   *
   * A malformed line aborts start rather than being skipped. A journal we
   * cannot fully read is a journal whose claim history we cannot vouch for, and
   * quietly resuming from a partial view is how a buyer gets submitted twice.
   */
  #replay(): void {
    if (!existsSync(this.#journal)) return;
    const lines = readFileSync(this.#journal, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      let record: StoreRecord;
      try {
        record = JSON.parse(line) as StoreRecord;
      } catch (error) {
        throw new Error(
          `${this.#journal}:${index + 1} is not readable, refusing to resume from a partial history: ${(error as Error).message}`,
        );
      }
      this.#apply(record);
    }
  }

  #apply(record: StoreRecord): void {
    if (record.type === "receipt") {
      const { campaignId, claimId, platform } = record.receipt;
      const key = keyOf(campaignId, claimId, platform);
      this.#receipts.set(key, record.receipt);
      this.#stateFor(key).reached.add("RECEIPT_SIGNED");
      return;
    }
    if (record.type === "dead-letter") return;

    const key = keyOf(record.campaignId, record.claimId, record.platform);
    const state = this.#stateFor(key);
    if (record.type === "intent") {
      state.reached.add("INTENT_RECORDED");
      // First intent wins. A replayed or duplicated intent must not move the
      // start of the SLA clock forward, which would flatter every latency
      // figure derived from it.
      if (!this.#intents.has(key)) this.#intents.set(key, record);
      return;
    }
    state.reached.add(record.state);

    const progress = this.#progressFor(key);
    if (record.outcome !== undefined) progress.outcomes.push(record.outcome);
    if (record.state === "AUDIENCE_ACCEPTED" && progress.audienceAcceptedAt === null) {
      // First acceptance wins. A replayed record must not restate the SLA
      // measurement at whatever time the replay happened.
      progress.audienceAcceptedAt = record.at;
    }
    // A conflict here is not something to resolve by preferring one value. The
    // journal is asserting two different buyers, or two different envelopes,
    // for one claim; exactly one of them can be what the platform received, and
    // nothing in the file says which. Silently keeping the first would produce
    // a receipt that reads as evidence and might name the wrong person.
    progress.subjectCommitment = adopt(
      progress.subjectCommitment,
      record.subjectCommitment,
      "subject commitment",
      record,
    );
    progress.envelopeFingerprint = adopt(
      progress.envelopeFingerprint,
      record.envelopeFingerprint,
      "envelope fingerprint",
      record,
    );
    if (record.state === "EXCLUSION_VERIFIED") {
      const digest = (record.outcome as { configurationDigest?: unknown } | undefined)
        ?.configurationDigest;
      if (typeof digest === "string") progress.exclusionDigest = digest;
    }

    // The budget bounds failures, not work. Counting successful steps would let
    // a claim that needed three ordinary calls exhaust a five-attempt budget
    // before it ever hit a problem.
    if (record.failure) {
      state.attempts = Math.max(state.attempts, record.attempt);
      state.lastFailure = record.failure;
    }
    if (record.skipReason) state.skipReason = record.skipReason;
  }

  #stateFor(key: string): SuppressionState {
    let state = this.#states.get(key);
    if (!state) {
      state = emptyState();
      this.#states.set(key, state);
    }
    return state;
  }

  #progressFor(key: string): ClaimProgress {
    let progress = this.#progress.get(key);
    if (!progress) {
      progress = emptyProgress();
      this.#progress.set(key, progress);
    }
    return progress;
  }

  /** What a restarted worker must know to finish a claim honestly. */
  progress(campaignId: string, claimId: string, platform: SuppressionPlatform): ClaimProgress {
    const existing = this.#progress.get(keyOf(campaignId, claimId, platform));
    return existing ? { ...existing, outcomes: [...existing.outcomes] } : emptyProgress();
  }

  /**
   * Claims this module took responsibility for and never finished.
   *
   * The cursor advances once intents for a whole block range are on disk, so
   * everything between "recorded" and "receipt signed" is recoverable from
   * here. Without it, a crash after the cursor moved would drop those claims
   * permanently: the blocks are never rescanned, and nothing else remembers.
   */
  unfinished(campaignId: string, platform: SuppressionPlatform): IntentRecord[] {
    const pending: IntentRecord[] = [];
    for (const [key, intent] of this.#intents) {
      if (intent.campaignId !== campaignId || intent.platform !== platform) continue;
      if (this.#states.get(key)?.reached.has("RECEIPT_SIGNED")) continue;
      pending.push(intent);
    }
    return pending.sort((a, b) => Number(BigInt(a.verifiedAtBlock) - BigInt(b.verifiedAtBlock)));
  }

  /**
   * Durably record that this claim is ours to finish. Idempotent, and returns
   * whether it was new, so a rescan of an already-processed range is free.
   */
  recordIntent(intent: IntentRecord): boolean {
    if (this.#intents.has(keyOf(intent.campaignId, intent.claimId, intent.platform))) return false;
    this.append(intent);
    return true;
  }

  append(record: StoreRecord): void {
    assertSafeToPersist(record, "SuppressionStore.append");
    appendFileSync(this.#journal, `${canonicalJSON(record)}\n`);
    this.#apply(record);
  }

  state(campaignId: string, claimId: string, platform: SuppressionPlatform): SuppressionState {
    const existing = this.#states.get(keyOf(campaignId, claimId, platform));
    return existing ?? emptyState();
  }

  /** True once an intent exists, whatever became of it. The watcher uses this
   * to avoid re-enqueuing a claim it has already taken responsibility for. */
  known(campaignId: string, claimId: string, platform: SuppressionPlatform): boolean {
    return this.#states.has(keyOf(campaignId, claimId, platform));
  }

  intent(
    campaignId: string,
    claimId: string,
    platform: SuppressionPlatform,
  ): IntentRecord | undefined {
    return this.#intents.get(keyOf(campaignId, claimId, platform));
  }

  receipt(
    campaignId: string,
    claimId: string,
    platform: SuppressionPlatform,
  ): SuppressionReceipt | undefined {
    return this.#receipts.get(keyOf(campaignId, claimId, platform));
  }

  receipts(): SuppressionReceipt[] {
    return [...this.#receipts.values()];
  }

  /** Replayed records, for telemetry that must be derived from what was
   * written rather than from whatever a process happens to remember. */
  records(): StoreRecord[] {
    if (!existsSync(this.#journal)) return [];
    return readFileSync(this.#journal, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as StoreRecord);
  }

  readCursor(campaignId: string): bigint | undefined {
    if (!existsSync(this.#cursorPath)) return undefined;
    const cursor = JSON.parse(readFileSync(this.#cursorPath, "utf8")) as Cursor;
    if (cursor.campaignId !== campaignId) return undefined;
    return BigInt(cursor.lastScannedBlock);
  }

  writeCursor(campaignId: string, lastScannedBlock: bigint): void {
    const cursor: Cursor = { campaignId, lastScannedBlock: lastScannedBlock.toString() };
    writeFileSync(this.#cursorPath, `${canonicalJSON(cursor)}\n`);
  }
}
