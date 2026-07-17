import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { evaluate, pickTarget, type Outcome } from "./policy.ts";

const A = "0x00000000000000000000000000000000000000aa" as Address;
const B = "0x00000000000000000000000000000000000000bb" as Address;
const X = "0x00000000000000000000000000000000000000cc" as Address;

const config = { windowSize: 8, rejectRateThreshold: 0.4, minSamples: 4 };

function outcomes(spec: [Address, boolean][]): Outcome[] {
  return spec.map(([publisher, approved]) => ({ publisher, approved }));
}

test("no decision below minimum sample size", () => {
  strictEqual(evaluate(outcomes([[X, false], [X, false], [X, false]]), config), null);
});

test("no decision when rejection rate is under the threshold", () => {
  const history = outcomes([
    [A, true], [A, true], [A, true], [A, false], [A, true], [A, true], [A, true], [A, true],
  ]);
  strictEqual(evaluate(history, config), null); // 1/8 = 0.125
});

test("trips on a fraudulent publisher crossing the threshold", () => {
  const history = outcomes([
    [A, true], [X, false], [A, true], [X, false], [B, true], [X, false], [X, true], [A, true],
  ]);
  // X window: [false,false,false,true] -> 0.75 >= 0.4, 4 samples
  deepStrictEqual(evaluate(history, config), { from: X, reason: "QUALITY_DIVERGENCE" });
});

test("only the last windowSize outcomes count", () => {
  const early = Array.from({ length: 8 }, () => [X, false] as [Address, boolean]);
  const recent = Array.from({ length: 8 }, () => [X, true] as [Address, boolean]);
  strictEqual(evaluate(outcomes([...early, ...recent]), config), null);
});

test("picks the cleanest candidate as the target", () => {
  const history = outcomes([
    [A, true], [A, true], [B, true], [B, false], [X, false], [X, false],
  ]);
  strictEqual(pickTarget(history, config, [A, B, X], X), A);
});

test("target never equals the source", () => {
  strictEqual(pickTarget(outcomes([[A, true]]), config, [A], A), null);
});

test("determinism: replaying the same sequence reproduces the decision (I-6)", () => {
  const history = outcomes([
    [A, true], [X, false], [X, false], [B, true], [X, false], [X, false], [A, true],
  ]);
  const first = evaluate(history, config);
  for (let i = 0; i < 50; i++) {
    deepStrictEqual(evaluate(history, config), first);
  }
});
