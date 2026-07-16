import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import { canonicalJSON } from "./canonical.ts";
import { evidenceHash, nullifier } from "./hashing.ts";
import type { SignedConversionEvent } from "./types.ts";

test("canonicalJSON sorts keys recursively and emits no whitespace", () => {
  strictEqual(
    canonicalJSON({ b: 2, a: [1, { d: 4, c: 3 }] }),
    '{"a":[1,{"c":3,"d":4}],"b":2}',
  );
});

test("canonicalJSON is key-order independent", () => {
  const x = { p: "1", q: [true, null], r: { z: 1, a: 2 } };
  const y = { r: { a: 2, z: 1 }, q: [true, null], p: "1" };
  strictEqual(canonicalJSON(x), canonicalJSON(y));
});

test("canonicalJSON round-trips through JSON.parse", () => {
  const v = { a: [1, 2.5, "s", false, null], b: { c: "ü™" } };
  deepStrictEqual(JSON.parse(canonicalJSON(v)), v);
});

test("canonicalJSON rejects what it cannot represent deterministically", () => {
  throws(() => canonicalJSON(undefined));
  throws(() => canonicalJSON(1n));
  throws(() => canonicalJSON(NaN));
  throws(() => canonicalJSON(Infinity));
  throws(() => canonicalJSON({ a: undefined }));
});

const CAMPAIGN = `0x${"11".repeat(32)}` as const;

test("nullifier: stability vector", () => {
  // Locked at authoring time. If this changes, every stored nullifier breaks.
  strictEqual(
    nullifier(CAMPAIGN, "c-001"),
    "0x6d8f6687f4adebea17f33bcfddad7918e4df87386b533506224fc713ae41c3b3",
  );
});

test("nullifier: distinct per campaign and per conversion", () => {
  const other = `0x${"22".repeat(32)}` as const;
  const n = nullifier(CAMPAIGN, "c-001");
  strictEqual(nullifier(CAMPAIGN, "c-001"), n);
  strictEqual(n === nullifier(CAMPAIGN, "c-002"), false);
  strictEqual(n === nullifier(other, "c-001"), false);
});

test("nullifier: input validation", () => {
  throws(() => nullifier("0x1234" as never, "c-001"));
  throws(() => nullifier("11".repeat(32) as never, "c-001"));
  throws(() => nullifier(CAMPAIGN, ""));
});

test("evidenceHash: stability vector over a signed event", () => {
  const ev: SignedConversionEvent = {
    campaignId: CAMPAIGN,
    conversionId: "c-001",
    publisherId: "pub-a",
    clickTs: 1752598000,
    conversionTs: 1752598042,
    signature: `0x${"ab".repeat(65)}`,
  };
  strictEqual(
    evidenceHash(ev),
    "0x56817be895cc235e8d87453d58bdfdd380de68565a756495147e6902a8c916d6",
  );
  // Any field change must change the hash — signature included.
  const tampered = { ...ev, signature: `0x${"ac".repeat(65)}` };
  strictEqual(evidenceHash(tampered) === evidenceHash(ev), false);
});
