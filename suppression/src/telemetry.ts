import { verifyReceipt } from "./receipt.ts";
import type { StoreRecord } from "./store.ts";
import type {
  ExclusionCoverage,
  ExecutionMode,
  ReceiptStatus,
  SkipReason,
  SuppressionPolicy,
} from "./types.ts";

/**
 * Metrics derived from the journal, never from a counter a process happened to
 * keep.
 *
 * A restarted worker with in-memory counters reports whatever it has seen since
 * it started, which is exactly when the numbers matter least. Replaying the
 * append-only record means every figure below traces to a stored line someone
 * can go and read.
 *
 * There is deliberately no savings, waste-avoided or impressions-prevented
 * figure. We observe that a platform accepted a submission; we do not observe
 * ad delivery, so any spend number would be a model presented as a measurement.
 * The only sound way to produce one is a holdout — a randomly withheld share of
 * converted buyers, with the spend difference measured against them — and that
 * requires deliberately continuing to advertise to some purchasers, which is an
 * advertiser's decision to make, not ours to assume.
 */

export interface Percentiles {
  p50: number;
  p90: number;
  p99: number;
  max: number;
  count: number;
}

/**
 * Everything a mode-scoped view reports. Deliberately has no aggregate across
 * modes: see `computeMetrics`.
 */
export interface ModeMetrics {
  receipts: number;
  byStatus: Record<ReceiptStatus, number>;
  /**
   * Observation to acceptance: `acceptedAt − observedAt`.
   *
   * Named for exactly what it spans, which is not the same as request to
   * acceptance — the envelope fetch and any retries sit inside this interval,
   * and calling it request latency would quietly drop them from a suppression
   * product's own headline figure.
   *
   * The remaining half of end-to-end latency, chain verification to our
   * observation, is deliberately absent: it needs the block's timestamp, and
   * substituting our own clock would flatter a lagging watcher. The receipt
   * carries `verifiedAtBlock` so a reader computes it from the stronger source.
   *
   * Measured only over receipts that reached acceptance; `count` states the
   * denominator so it is never mistaken for a rate over all claims.
   */
  observationToAcceptanceMs: Percentiles | null;
  slaAttainment: { within: number; measured: number } | null;
}

export interface SuppressionMetrics {
  /** Claims this module took responsibility for, across every mode. Counted
   * from `intent` records, which precede any platform contact and so cannot be
   * attributed to a mode. */
  intents: number;
  /**
   * Results partitioned by the mode the work actually ran in, taken from the
   * signed `executionMode` on each receipt.
   *
   * There is deliberately no combined total. A mock completion and a dry-run
   * completion are records of work that never reached a platform, and summing
   * them with live ones produces a completion rate that looks like evidence and
   * is not. Any caller wanting a headline figure has to name the mode, which is
   * the point.
   */
  byMode: Record<ExecutionMode, ModeMetrics>;
  /**
   * Counted from transitions and dead letters, which carry no execution mode —
   * they are recorded before a receipt exists. Reported at the top level rather
   * than guessed into a mode.
   */
  skips: Partial<Record<SkipReason, number>>;
  retries: number;
  deadLetters: number;
  amendments: number;
  /** Most recent observed exclusion coverage, if a check completed. Reported
   * against the declared target scope, so it reads as completeness rather than
   * as a share of whatever happened to be inspected. */
  exclusionCoverage: ExclusionCoverage | null;
}

function emptyMode(): ModeMetrics {
  return {
    receipts: 0,
    byStatus: { COMPLETED: 0, PARTIAL: 0, FAILED: 0, SKIPPED: 0 },
    observationToAcceptanceMs: null,
    slaAttainment: null,
  };
}

export function computeMetrics(
  records: StoreRecord[],
  policy: SuppressionPolicy,
): SuppressionMetrics {
  const modes: Record<ExecutionMode, ModeMetrics> = {
    live: emptyMode(),
    "dry-run": emptyMode(),
    mock: emptyMode(),
  };
  const latencies: Record<ExecutionMode, number[]> = { live: [], "dry-run": [], mock: [] };
  const within: Record<ExecutionMode, number> = { live: 0, "dry-run": 0, mock: 0 };

  const skips: Partial<Record<SkipReason, number>> = {};
  let intents = 0;
  let retries = 0;
  let deadLetters = 0;
  let amendments = 0;
  let exclusionCoverage: ExclusionCoverage | null = null;

  for (const record of records) {
    switch (record.type) {
      case "intent":
        intents++;
        break;

      case "dead-letter":
        deadLetters++;
        break;

      case "transition": {
        if (record.state === "RETRY_SCHEDULED") retries++;
        if (record.state === "AMENDED") amendments++;
        if (record.skipReason) skips[record.skipReason] = (skips[record.skipReason] ?? 0) + 1;
        const coverage = (record.outcome as { coverage?: unknown } | undefined)?.coverage;
        if (isCoverage(coverage)) exclusionCoverage = coverage;
        break;
      }

      case "receipt": {
        // The mode is signed into the receipt, so this partition cannot be
        // shifted by anything downstream without breaking the signature.
        const mode = record.receipt.executionMode;
        const bucket = modes[mode];
        if (!bucket) break;
        bucket.receipts++;
        bucket.byStatus[record.receipt.status]++;
        const { observedAt, acceptedAt } = record.receipt;
        if (acceptedAt) {
          const elapsed = Date.parse(acceptedAt) - Date.parse(observedAt);
          if (Number.isFinite(elapsed) && elapsed >= 0) {
            latencies[mode].push(elapsed);
            if (elapsed <= policy.slaSeconds * 1000) within[mode]++;
          }
        }
        break;
      }
    }
  }

  for (const mode of Object.keys(modes) as ExecutionMode[]) {
    modes[mode].observationToAcceptanceMs = percentiles(latencies[mode]);
    modes[mode].slaAttainment =
      latencies[mode].length === 0
        ? null
        : { within: within[mode], measured: latencies[mode].length };
  }

  return {
    intents,
    byMode: modes,
    skips,
    retries,
    deadLetters,
    amendments,
    exclusionCoverage,
  };
}

/** Nearest-rank on the sorted sample. No interpolation: with the sample sizes
 * this runs over, an interpolated p99 is a number nobody observed. */
export function percentiles(values: number[]): Percentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return {
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
}

function isCoverage(value: unknown): value is ExclusionCoverage {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.targeted === "number" &&
    typeof c.observed === "number" &&
    typeof c.excluding === "number" &&
    Array.isArray(c.unresolved)
  );
}

/**
 * Signature validity across every receipt in the journal.
 *
 * Separate from `computeMetrics` and asynchronous, because recovery is: keeping
 * the metrics function synchronous and pure is worth more than folding this in.
 *
 * What it establishes is narrow and worth stating plainly: that each stored
 * receipt still verifies against the signer it names. It does not establish that
 * the signer was authorised — that is a question about key management, not about
 * the journal. A receipt failing here means the file was altered after signing,
 * which is the one thing a stored-evidence claim cannot survive.
 */
export interface SignatureAudit {
  checked: number;
  valid: number;
  invalid: Array<{ receiptId: string; reason: string }>;
}

export async function auditReceipts(records: StoreRecord[]): Promise<SignatureAudit> {
  const audit: SignatureAudit = { checked: 0, valid: 0, invalid: [] };
  for (const record of records) {
    if (record.type !== "receipt") continue;
    audit.checked++;
    const result = await verifyReceipt(record.receipt);
    if (result.valid) audit.valid++;
    else audit.invalid.push({ receiptId: record.receipt.receiptId, reason: result.reason });
  }
  return audit;
}
