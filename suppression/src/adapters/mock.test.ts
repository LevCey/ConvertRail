import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MockSuppressionAdapter } from "./mock.ts";
import { GoogleSuppressionAdapter } from "./google.ts";
import { TikTokSuppressionAdapter } from "./tiktok.ts";
import { NotImplementedAdapterError } from "./types.ts";
import { PlatformSubject } from "../types.ts";

const KEY = "0xabc:7:mock:conversion:v1";

function conversion(key = KEY) {
  return {
    idempotencyKey: key,
    eventId: "e".repeat(32),
    occurredAtUnix: 1_785_000_000,
    order: { value: "49.99", currency: "USD" },
    subject: new PlatformSubject({ em: "9".repeat(64) }),
    dryRun: false,
  };
}

function audience(key = "0xabc:7:mock:audience:v1") {
  return { idempotencyKey: key, subject: new PlatformSubject({ em: "9".repeat(64) }), dryRun: false };
}

test("an accepted conversion reports acceptance, never delivery", async () => {
  const adapter = new MockSuppressionAdapter();
  const result = await adapter.sendConversion(conversion());
  assert.equal(result.kind, "accepted");
  assert.equal(typeof result.platformRef, "string");
  assert.equal(result.failure, undefined);
});

test("a repeated key is deduplicated instead of acting twice", async () => {
  const adapter = new MockSuppressionAdapter();
  const first = await adapter.sendConversion(conversion());
  const second = await adapter.sendConversion(conversion());
  assert.equal(second.platformRef, first.platformRef);
  assert.equal(second.detail.deduplicated, true);
  assert.equal(adapter.effectCount("conversion"), 1);
});

test("a different key is a different effect", async () => {
  const adapter = new MockSuppressionAdapter();
  await adapter.sendConversion(conversion());
  await adapter.sendConversion(conversion("0xabc:8:mock:conversion:v1"));
  assert.equal(adapter.effectCount("conversion"), 2);
});

test("a transient step yields unknown-retryable, then succeeds under the same key", async () => {
  const adapter = new MockSuppressionAdapter({ conversion: ["transient", "accepted"] });
  const first = await adapter.sendConversion(conversion());
  assert.equal(first.kind, "unknown");
  assert.equal(first.failure?.retryable, true);
  assert.equal(first.platformRef, undefined);

  const second = await adapter.sendConversion(conversion());
  assert.equal(second.kind, "accepted");
  assert.equal(adapter.effectCount("conversion"), 1);
});

test("an unknown result is never reported as acceptance", async () => {
  const adapter = new MockSuppressionAdapter({ conversion: ["unknown"] });
  const result = await adapter.sendConversion(conversion());
  assert.equal(result.kind, "unknown");
  assert.equal(result.failure?.class, "transport");
  assert.equal(result.failure?.retryable, true);
});

test("a permanent rejection is not retryable and stays rejected", async () => {
  const adapter = new MockSuppressionAdapter({ conversion: ["permanent", "accepted"] });
  const first = await adapter.sendConversion(conversion());
  assert.equal(first.kind, "rejected");
  assert.equal(first.failure?.retryable, false);
  assert.equal((await adapter.sendConversion(conversion())).kind, "rejected");
});

test("the script's last step repeats once exhausted", async () => {
  const adapter = new MockSuppressionAdapter({ conversion: ["transient"] });
  for (let i = 0; i < 3; i++) {
    assert.equal((await adapter.sendConversion(conversion())).kind, "unknown");
  }
});

test("the audience track is scripted independently of the conversion track", async () => {
  const adapter = new MockSuppressionAdapter({ conversion: ["accepted"], audience: ["permanent"] });
  assert.equal((await adapter.sendConversion(conversion())).kind, "accepted");
  assert.equal((await adapter.addToExclusionAudience(audience())).kind, "rejected");
});

test("exclusion verification reports coverage rather than a boolean", async () => {
  const adapter = new MockSuppressionAdapter({
    coverage: { targeted: 3, observed: 3, excluding: 2, unresolved: [] },
  });
  const result = await adapter.verifyExclusionConfiguration({ idempotencyKey: "k", dryRun: false });
  assert.equal(result.kind, "processed");
  assert.deepEqual(result.coverage, { targeted: 3, observed: 3, excluding: 2, unresolved: [] });
  assert.match(result.configurationDigest ?? "", /^0x[0-9a-f]{64}$/);
});

test("a failed exclusion check carries no coverage claim", async () => {
  const adapter = new MockSuppressionAdapter({ exclusion: ["unknown"] });
  const result = await adapter.verifyExclusionConfiguration({ idempotencyKey: "k", dryRun: false });
  assert.equal(result.kind, "unknown");
  assert.equal(result.coverage, undefined);
  assert.equal(result.configurationDigest, undefined);
});

test("the adapter records which identifier kinds it saw, never their values", async () => {
  const adapter = new MockSuppressionAdapter();
  await adapter.sendConversion(conversion());
  assert.deepEqual(adapter.calls[0].subjectKinds, ["em"]);
  assert.equal(JSON.stringify(adapter.calls).includes("9".repeat(64)), false);
});

test("the interface-only adapters refuse to run", async () => {
  for (const adapter of [new GoogleSuppressionAdapter(), new TikTokSuppressionAdapter()]) {
    await assert.rejects(() => adapter.sendConversion(conversion()), NotImplementedAdapterError);
    await assert.rejects(() => adapter.addToExclusionAudience(audience()), NotImplementedAdapterError);
    await assert.rejects(
      () => adapter.verifyExclusionConfiguration({ idempotencyKey: "k", dryRun: false }),
      NotImplementedAdapterError,
    );
  }
});
