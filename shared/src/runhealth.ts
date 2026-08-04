/**
 * Run-health evaluation, as a pure function so it can be tested rather than
 * trusted.
 *
 * It exists because the first version of this logic lived inline in the e2e
 * harness and asserted something arithmetically impossible: it required
 * `verdictRate >= arrivalRate * 1.2` with both rates computed over the same
 * span. Duplicate verdicts are forbidden by a separate correctness gate, so
 * every verdict belongs to a distinct claim and `verdicts <= submitted` always
 * holds — the ratio's ceiling is 1.0. A run that decided *every* claim would
 * still have failed. Three runs were spent chasing that number before the
 * arithmetic was checked.
 *
 * What survives as a gate is the question that assertion was reaching for and
 * got wrong: is the verifier still falling behind at the end? That is a
 * backlog-direction question, and it is answerable.
 */

export interface ClaimEvent {
  claimId: string;
  block: number;
}

export interface RunHealth {
  spanBlocks: number;
  spanSeconds: number;
  submitted: number;
  verdicts: number;
  /** Verdicts per claim. 1.0 means every claim was decided. */
  completionRatio: number;
  arrivalRate: number;
  verdictRate: number;
  /** Outstanding claims at each quarter boundary. The fourth is pinned to the
   * last block seen, so it is the run's true final backlog rather than a
   * truncated cut. */
  backlogByQuarter: [number, number, number, number];
  finalBacklog: number;
  lag: { first: number; median: number; final: number } | null;
  failures: string[];
}

const DEFAULT_SECONDS_PER_BLOCK = 0.512;

export function evaluateRunHealth(
  submitted: ClaimEvent[],
  verdicts: ClaimEvent[],
  secondsPerBlock: number = DEFAULT_SECONDS_PER_BLOCK,
): RunHealth {
  const failures: string[] = [];

  if (submitted.length === 0 || verdicts.length === 0) {
    return {
      spanBlocks: 0,
      spanSeconds: 0,
      submitted: submitted.length,
      verdicts: verdicts.length,
      completionRatio: 0,
      arrivalRate: 0,
      verdictRate: 0,
      backlogByQuarter: [0, 0, 0, 0],
      finalBacklog: submitted.length - verdicts.length,
      lag: null,
      failures: ["run health: not enough events to evaluate"],
    };
  }

  const subBlocks = submitted.map((e) => e.block).sort((a, b) => a - b);
  const verBlocks = verdicts.map((e) => e.block).sort((a, b) => a - b);
  const lo = Math.min(subBlocks[0], verBlocks[0]);
  const hi = Math.max(subBlocks[subBlocks.length - 1], verBlocks[verBlocks.length - 1]);
  const spanBlocks = hi - lo;
  const spanSeconds = Math.max(spanBlocks * secondsPerBlock, secondsPerBlock);

  const outstanding = (cut: number): number =>
    subBlocks.filter((b) => b <= cut).length - verBlocks.filter((b) => b <= cut).length;

  // Quarter cuts. The last one is `hi` itself, not `lo + 4q`: integer division
  // leaves a remainder, and cutting there silently drops the tail blocks — the
  // exact stretch where a backlog verdict matters most.
  const q = Math.floor(spanBlocks / 4);
  const cuts: [number, number, number, number] = [lo + q, lo + 2 * q, lo + 3 * q, hi];
  const backlogByQuarter = cuts.map(outstanding) as [number, number, number, number];
  const finalBacklog = submitted.length - verdicts.length;

  // The one real gate: the verifier must not be losing ground at the finish.
  if (backlogByQuarter[3] > backlogByQuarter[2]) {
    failures.push(
      `backlog gate: Q4 ${backlogByQuarter[3]} > Q3 ${backlogByQuarter[2]} — ` +
        `backlog still growing at the end`,
    );
  }

  const subByClaim = new Map(submitted.map((e) => [e.claimId, e.block]));
  const pairs = verdicts
    .filter((v) => subByClaim.has(v.claimId))
    .map((v) => v.block - subByClaim.get(v.claimId)!)
    .sort((a, b) => a - b);

  return {
    spanBlocks,
    spanSeconds,
    submitted: submitted.length,
    verdicts: verdicts.length,
    completionRatio: verdicts.length / submitted.length,
    arrivalRate: submitted.length / spanSeconds,
    verdictRate: verdicts.length / spanSeconds,
    backlogByQuarter,
    finalBacklog,
    lag: pairs.length
      ? { first: pairs[0], median: pairs[Math.floor(pairs.length / 2)], final: pairs[pairs.length - 1] }
      : null,
    failures,
  };
}
