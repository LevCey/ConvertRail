import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { evaluateRunHealth, type ClaimEvent } from "./runhealth.ts";

/** n claims, one per block starting at `from`. */
function claims(from: number, n: number, prefix = "c"): ClaimEvent[] {
  return Array.from({ length: n }, (_, i) => ({ claimId: `${prefix}${i}`, block: from + i }));
}

test("a fully caught-up, duplicate-free run does not fail", () => {
  // Every claim decided, each one block later. This is the case the previous
  // inline assertion could not pass: with verdicts <= submitted always true,
  // it demanded a verdict rate 20% above a ceiling of 1.0.
  const submitted = claims(100, 40);
  const verdicts = submitted.map((c) => ({ claimId: c.claimId, block: c.block + 1 }));
  const health = evaluateRunHealth(submitted, verdicts);
  deepStrictEqual(health.failures, []);
  strictEqual(health.completionRatio, 1);
  strictEqual(health.finalBacklog, 0);
});

test("verdict rate can never exceed arrival rate, so it is telemetry and not a gate", () => {
  const submitted = claims(100, 40);
  const verdicts = submitted.map((c) => ({ claimId: c.claimId, block: c.block + 1 }));
  const health = evaluateRunHealth(submitted, verdicts);
  // Equal counts over one span: the ratio's ceiling. Anything demanding more is
  // unsatisfiable by construction.
  strictEqual(health.verdicts <= health.submitted, true);
  strictEqual(health.failures.length, 0);
});

test("a backlog growing in the last quarter is detected", () => {
  // Verdicts stop after the halfway mark, so outstanding climbs to the end.
  const submitted = claims(100, 40);
  const verdicts = submitted.slice(0, 15).map((c) => ({ claimId: c.claimId, block: c.block + 1 }));
  const health = evaluateRunHealth(submitted, verdicts);
  strictEqual(health.failures.length, 1);
  strictEqual(health.failures[0].startsWith("backlog gate:"), true);
  strictEqual(health.backlogByQuarter[3] > health.backlogByQuarter[2], true);
});

test("a backlog that peaks then drains passes", () => {
  const submitted = claims(100, 40);
  // Slow start, then the verifier catches up and clears everything.
  const verdicts = submitted.map((c, i) => ({
    claimId: c.claimId,
    block: i < 20 ? c.block + 12 : c.block + 1,
  }));
  const health = evaluateRunHealth(submitted, verdicts);
  deepStrictEqual(health.failures, []);
  strictEqual(health.backlogByQuarter[3] <= health.backlogByQuarter[2], true);
});

test("Q4 is pinned to the last block, so tail blocks are never dropped", () => {
  // Span 41 blocks: floor(41/4) = 10, so a naive `lo + 4q` cut lands at +40 and
  // misses the final block. The undecided claim lives exactly there.
  const submitted = [...claims(100, 41)];
  const verdicts = submitted.slice(0, 40).map((c) => ({ claimId: c.claimId, block: c.block }));
  const health = evaluateRunHealth(submitted, verdicts);
  strictEqual(health.finalBacklog, 1);
  strictEqual(
    health.backlogByQuarter[3],
    health.finalBacklog,
    "Q4 must equal the true final backlog, not a truncated cut",
  );
});

test("duplicate verdicts are not this function's concern", () => {
  // Two verdicts for one claim would push the ratio above 1.0. Run health does
  // not police it — the e2e harness has a dedicated correctness gate for
  // duplicates, and mixing the two is what produced an impossible assertion.
  const submitted = claims(100, 10);
  const verdicts = [
    ...submitted.map((c) => ({ claimId: c.claimId, block: c.block + 1 })),
    { claimId: "c0", block: 102 },
  ];
  const health = evaluateRunHealth(submitted, verdicts);
  strictEqual(health.completionRatio > 1, true);
  deepStrictEqual(
    health.failures,
    [],
    "run health reports the ratio and stays silent; duplicates fail elsewhere",
  );
});

test("empty input reports a named failure rather than dividing by zero", () => {
  const health = evaluateRunHealth([], []);
  strictEqual(health.failures.length, 1);
  strictEqual(health.spanSeconds, 0);
});

test("lag is measured by pairing claim ids, not by position", () => {
  const submitted = claims(100, 5);
  const verdicts = [...submitted].reverse().map((c) => ({ claimId: c.claimId, block: c.block + 3 }));
  const health = evaluateRunHealth(submitted, verdicts);
  deepStrictEqual(health.lag, { first: 3, median: 3, final: 3 });
});
