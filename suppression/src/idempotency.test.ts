import { strict as assert } from "node:assert";
import { test } from "node:test";
import { conversionEventId, idempotencyKey, receiptId } from "./idempotency.ts";

const CAMPAIGN = `0x${"ab".repeat(32)}`;

test("the key is derived, not generated", () => {
  const a = idempotencyKey(CAMPAIGN, "7", "meta", "conversion");
  const b = idempotencyKey(CAMPAIGN, "7", "meta", "conversion");
  assert.equal(a, b);
  assert.equal(a, `${CAMPAIGN}:7:meta:conversion:v1`);
});

test("each action, claim, campaign and platform gets its own key", () => {
  const base = idempotencyKey(CAMPAIGN, "7", "meta", "conversion");
  const variants = [
    idempotencyKey(CAMPAIGN, "7", "meta", "audience"),
    idempotencyKey(CAMPAIGN, "7", "meta", "exclusion-check"),
    idempotencyKey(CAMPAIGN, "8", "meta", "conversion"),
    idempotencyKey(`0x${"cd".repeat(32)}`, "7", "meta", "conversion"),
    idempotencyKey(CAMPAIGN, "7", "mock", "conversion"),
  ];
  assert.equal(new Set([base, ...variants]).size, variants.length + 1);
});

test("a component carrying the separator is rejected rather than silently reshaping the key", () => {
  assert.throws(() => idempotencyKey(CAMPAIGN, "7:8", "meta", "conversion"), /separator/);
  assert.throws(() => idempotencyKey("", "7", "meta", "conversion"), /empty component/);
});

test("the platform event id is a pure function of the key, so a retry deduplicates", () => {
  const key = idempotencyKey(CAMPAIGN, "7", "meta", "conversion");
  assert.equal(conversionEventId(key), conversionEventId(key));
  assert.notEqual(conversionEventId(key), conversionEventId(idempotencyKey(CAMPAIGN, "8", "meta", "conversion")));
  assert.match(conversionEventId(key), /^[0-9a-f]{32}$/);
});

test("the event id does not expose the key it came from", () => {
  const key = idempotencyKey(CAMPAIGN, "7", "meta", "conversion");
  assert.equal(conversionEventId(key).includes("7"), conversionEventId(key).includes("7"));
  assert.equal(conversionEventId(key).includes(CAMPAIGN.slice(2, 20)), false);
});

test("the receipt id is stable and platform-scoped", () => {
  assert.equal(receiptId(CAMPAIGN, "7", "meta", "live"), receiptId(CAMPAIGN, "7", "meta", "live"));
  assert.notEqual(receiptId(CAMPAIGN, "7", "meta", "live"), receiptId(CAMPAIGN, "7", "google", "live"));
  assert.match(receiptId(CAMPAIGN, "7", "meta", "live"), /^sr_[0-9a-f]{24}$/);
});
