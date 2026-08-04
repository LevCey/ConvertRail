import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { serializeByKey } from "./serialize.ts";

/**
 * Reproduces the shape of the double-counting bug: a read-then-advance cycle
 * with an await in the middle. Without serialisation two concurrent callers
 * both observe the stale cursor, both scan the same range, and both append it.
 */
function makeScanner() {
  const events: number[] = [];
  let cursor = 0;
  const head = 5;
  let scans = 0;
  const scan = async (): Promise<void> => {
    if (cursor >= head) return;
    const from = cursor;
    scans++;
    await new Promise((r) => setTimeout(r, 10)); // the window the bug lived in
    for (let b = from; b < head; b++) events.push(b);
    cursor = head;
  };
  return { events, scan, scans: () => scans, cursor: () => cursor };
}

test("without serialisation, two concurrent scans append the same range twice", async () => {
  // Not a test of our code — it pins the failure mode the fix exists for, so a
  // future refactor that drops the queue fails the next test rather than
  // silently doubling every counter again.
  const s = makeScanner();
  await Promise.all([s.scan(), s.scan()]);
  strictEqual(s.events.length, 10, "the unguarded version double-appends");
  deepStrictEqual(s.events, [0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
});

test("serializeByKey prevents two concurrent state requests double-appending", async () => {
  const s = makeScanner();
  await Promise.all([
    serializeByKey("campaign-a", () => s.scan()),
    serializeByKey("campaign-a", () => s.scan()),
  ]);
  strictEqual(s.events.length, 5, "each block appears exactly once");
  deepStrictEqual(s.events, [0, 1, 2, 3, 4]);
  strictEqual(s.scans(), 1, "the second caller found nothing left to scan");
});

test("serialisation holds across more than two concurrent callers", async () => {
  const s = makeScanner();
  await Promise.all(
    Array.from({ length: 6 }, () => serializeByKey("campaign-b", () => s.scan())),
  );
  strictEqual(s.events.length, 5);
  strictEqual(s.scans(), 1);
});

test("different campaigns are not serialised against each other", async () => {
  const a = makeScanner();
  const b = makeScanner();
  const started = Date.now();
  await Promise.all([
    serializeByKey("camp-1", () => a.scan()),
    serializeByKey("camp-2", () => b.scan()),
  ]);
  strictEqual(a.events.length, 5);
  strictEqual(b.events.length, 5);
  // Two 10 ms scans in parallel, not one after the other. Generous bound: the
  // point is that one campaign does not queue behind an unrelated one.
  strictEqual(Date.now() - started < 40, true);
});

test("a failed task does not wedge the queue for the next caller", async () => {
  const s = makeScanner();
  await serializeByKey("campaign-c", async () => {
    throw new Error("scan failed");
  }).catch(() => undefined);
  await serializeByKey("campaign-c", () => s.scan());
  strictEqual(s.events.length, 5, "the queue recovered and the next scan ran");
});

test("results are returned to their own caller", async () => {
  const first = await serializeByKey("campaign-d", async () => "one");
  const second = await serializeByKey("campaign-d", async () => "two");
  strictEqual(first, "one");
  strictEqual(second, "two");
});
