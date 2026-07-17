// Pure reallocation policy: a deterministic function of the ordered on-chain
// verdict sequence. Replaying the same sequence reproduces the decision (I-6).
import type { Address } from "viem";

export interface Outcome {
  publisher: Address;
  approved: boolean;
}

export interface ReallocationConfig {
  windowSize: number;
  rejectRateThreshold: number;
  minSamples: number;
}

export interface ReallocationDecision {
  from: Address;
  reason: "QUALITY_DIVERGENCE";
}

/**
 * Evaluates the ordered verdict history. A publisher trips the policy when,
 * over its last `windowSize` outcomes, the rejection rate reaches the
 * threshold with at least `minSamples` observations. Returns the tripping
 * publisher (deterministically the one with the highest rejection rate,
 * ties broken by address ordering), or null.
 */
export function evaluate(outcomes: Outcome[], config: ReallocationConfig): ReallocationDecision | null {
  const byPublisher = new Map<Address, boolean[]>();
  for (const outcome of outcomes) {
    const list = byPublisher.get(outcome.publisher) ?? [];
    list.push(outcome.approved);
    byPublisher.set(outcome.publisher, list);
  }

  let worst: { publisher: Address; rate: number } | null = null;
  for (const [publisher, history] of byPublisher) {
    const window = history.slice(-config.windowSize);
    if (window.length < config.minSamples) continue;
    const rejected = window.filter((approved) => !approved).length;
    const rate = rejected / window.length;
    if (rate < config.rejectRateThreshold) continue;
    if (
      worst === null ||
      rate > worst.rate ||
      (rate === worst.rate && publisher.toLowerCase() < worst.publisher.toLowerCase())
    ) {
      worst = { publisher, rate };
    }
  }
  return worst === null ? null : { from: worst.publisher, reason: "QUALITY_DIVERGENCE" };
}

/** Picks the reallocation target: the enrolled publisher (excluding `from`)
 * with the lowest rejection rate over its window; ties broken by address. */
export function pickTarget(
  outcomes: Outcome[],
  config: ReallocationConfig,
  candidates: Address[],
  from: Address,
): Address | null {
  let best: { publisher: Address; rate: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.toLowerCase() === from.toLowerCase()) continue;
    const history = outcomes.filter((o) => o.publisher === candidate).map((o) => o.approved);
    const window = history.slice(-config.windowSize);
    const rejected = window.filter((approved) => !approved).length;
    const rate = window.length === 0 ? 0 : rejected / window.length;
    if (
      best === null ||
      rate < best.rate ||
      (rate === best.rate && candidate.toLowerCase() < best.publisher.toLowerCase())
    ) {
      best = { publisher: candidate, rate };
    }
  }
  return best?.publisher ?? null;
}
