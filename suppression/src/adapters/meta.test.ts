import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { MetaSuppressionAdapter, classify, sessionId, type MetaConfig } from "./meta.ts";
import { PlatformSubject } from "../types.ts";
import { exclusionIsComplete } from "../core.ts";

const TOKEN = "EAA-secret-token-value";
const EM = "9".repeat(64);
const PH = "8".repeat(64);

function config(overrides: Partial<MetaConfig> = {}): MetaConfig {
  return {
    apiVersion: "v25.0",
    accessToken: TOKEN,
    pixelId: "1234567890",
    audienceId: "9876543210",
    adAccountId: "act_555000111",
    acquisitionAdSetIds: ["100", "200"],
    baseUrl: "https://graph.example.invalid",
    timeoutMs: 1000,
    ...overrides,
  };
}

interface Capture {
  url: string;
  init: RequestInit;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(reply: { status?: number; json?: unknown } | Error): Capture[] {
  const calls: Capture[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (reply instanceof Error) throw reply;
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      json: async () => reply.json ?? {},
    } as Response;
  }) as typeof fetch;
  return calls;
}

function subject(): PlatformSubject {
  return new PlatformSubject({ em: EM, ph: PH });
}

function conversion(dryRun = false) {
  return {
    idempotencyKey: "0xabc:7:meta:conversion:v1",
    eventId: "e".repeat(32),
    occurredAtUnix: 1_785_000_000,
    order: { value: "49.99", currency: "USD" },
    subject: subject(),
    dryRun,
  };
}

test("a dry run reaches no network and reports the whole request it withheld", async () => {
  const calls = stubFetch({ json: {} });
  const outcome = await new MetaSuppressionAdapter(config()).sendConversion(conversion(true));
  assert.equal(calls.length, 0);
  assert.equal(outcome.kind, "accepted");
  assert.equal(outcome.platformRef, "dryrun_conversion");

  // The whole detail, not just the flag. A dry run that reported only
  // `dryRun: true` would be indistinguishable from one that had assembled the
  // wrong request, which is the single thing a dry run exists to check.
  assert.deepEqual(outcome.detail, {
    eventId: "e".repeat(32),
    occurredAtUnix: 1_785_000_000,
    hasOrder: true,
    currency: "USD",
    dryRun: true,
  });
  assert.equal(outcome.failure, undefined);
});

test("a dry run without an order value says so rather than implying one", async () => {
  const calls = stubFetch({ json: {} });
  const outcome = await new MetaSuppressionAdapter(config()).sendConversion({
    ...conversion(true),
    order: null,
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(outcome.detail, {
    eventId: "e".repeat(32),
    occurredAtUnix: 1_785_000_000,
    hasOrder: false,
    currency: "none",
    dryRun: true,
  });
});

test("a dry-run audience write reports its detail and touches nothing", async () => {
  const calls = stubFetch({ json: {} });
  const outcome = await new MetaSuppressionAdapter(config()).addToExclusionAudience({
    idempotencyKey: "0xabc:7:meta:audience:v1",
    subject: subject(),
    dryRun: true,
  });
  assert.equal(calls.length, 0);
  assert.equal(outcome.kind, "accepted");
  assert.equal(outcome.platformRef, "dryrun_audience");
  assert.deepEqual(outcome.detail, { identifiers: 2, dryRun: true });
});

test("a dry-run outcome carries no platform-side identifier that could be mistaken for real", async () => {
  stubFetch({ json: { events_received: 1, fbtrace_id: "Atrace" } });
  const adapter = new MetaSuppressionAdapter(config());
  const dry = await adapter.sendConversion(conversion(true));
  const live = await adapter.sendConversion(conversion(false));
  assert.notEqual(dry.platformRef, live.platformRef);
  assert.match(String(dry.platformRef), /^dryrun_/);
  assert.equal(live.detail.dryRun, undefined, "a live outcome carries no dry-run marker");
});

test("a missing token fails closed without a request", async () => {
  const calls = stubFetch({ json: {} });
  const outcome = await new MetaSuppressionAdapter(config({ accessToken: "" })).sendConversion(conversion());
  assert.equal(calls.length, 0);
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.failure?.class, "authorisation");
  assert.equal(outcome.failure?.retryable, false);
});

test("the conversion goes to the pinned version and pixel with the caller's event id", async () => {
  const calls = stubFetch({ json: { events_received: 1, fbtrace_id: "Atrace" } });
  await new MetaSuppressionAdapter(config()).sendConversion(conversion());
  assert.equal(calls[0].url, "https://graph.example.invalid/v25.0/1234567890/events");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.data[0].event_id, "e".repeat(32));
  assert.equal(body.data[0].event_name, "Purchase");
  assert.equal(body.data[0].event_time, 1_785_000_000);
  assert.deepEqual(body.data[0].user_data, { em: EM, ph: PH });
  assert.deepEqual(body.data[0].custom_data, { currency: "USD", value: "49.99" });
});

test("the test event code is sent only when configured", async () => {
  let calls = stubFetch({ json: { events_received: 1 } });
  await new MetaSuppressionAdapter(config()).sendConversion(conversion());
  assert.equal("test_event_code" in JSON.parse(String(calls[0].init.body)), false);

  calls = stubFetch({ json: { events_received: 1 } });
  await new MetaSuppressionAdapter(config({ testEventCode: "TEST1234" })).sendConversion(conversion());
  assert.equal(JSON.parse(String(calls[0].init.body)).test_event_code, "TEST1234");
});

test("events_received above zero is acceptance, never delivery", async () => {
  stubFetch({ json: { events_received: 1, fbtrace_id: "Atrace" } });
  const outcome = await new MetaSuppressionAdapter(config()).sendConversion(conversion());
  assert.equal(outcome.kind, "accepted");
  assert.equal(outcome.platformRef, "Atrace");
  assert.equal(outcome.detail.eventsReceived, 1);
});

test("an ambiguous success body is unknown and retryable, not assumed successful", async () => {
  stubFetch({ json: { ok: true } });
  const outcome = await new MetaSuppressionAdapter(config()).sendConversion(conversion());
  assert.equal(outcome.kind, "unknown");
  assert.equal(outcome.failure?.retryable, true);
  assert.equal(outcome.failure?.code, "META_AMBIGUOUS_RESPONSE");
});

test("zero events received is a rejection, not a retry", async () => {
  stubFetch({ json: { events_received: 0 } });
  const outcome = await new MetaSuppressionAdapter(config()).sendConversion(conversion());
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.failure?.retryable, false);
});

test("a request that never returned is unknown, so the retry reuses the same event id", async () => {
  stubFetch(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
  const outcome = await new MetaSuppressionAdapter(config()).sendConversion(conversion());
  assert.equal(outcome.kind, "unknown");
  assert.equal(outcome.failure?.class, "transport");
  assert.equal(outcome.failure?.retryable, true);
});

test("the audience payload uses the documented hashed schema and a derived session", async () => {
  const calls = stubFetch({ json: { num_received: 1, num_invalid_entries: 0, session_id: "77" } });
  const outcome = await new MetaSuppressionAdapter(config()).addToExclusionAudience({
    idempotencyKey: "0xabc:7:meta:audience:v1",
    subject: subject(),
    dryRun: false,
  });
  assert.equal(calls[0].url, "https://graph.example.invalid/v25.0/9876543210/users");
  const { payload } = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(payload.schema, ["EMAIL_SHA256", "PHONE_SHA256"]);
  assert.deepEqual(payload.data, [[EM, PH]]);
  assert.equal(payload.is_raw, false);
  assert.equal(payload.session.session_id, sessionId("0xabc:7:meta:audience:v1"));
  assert.equal(payload.session.last_batch_flag, true);
  assert.equal(outcome.kind, "accepted");
  assert.equal(outcome.platformRef, "77");
});

test("an invalid entry is a rejection even when the request itself succeeded", async () => {
  stubFetch({ json: { num_received: 1, num_invalid_entries: 1 } });
  const outcome = await new MetaSuppressionAdapter(config()).addToExclusionAudience({
    idempotencyKey: "k",
    subject: subject(),
    dryRun: false,
  });
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.failure?.code, "META_ENTRY_INVALID");
  assert.equal(outcome.failure?.retryable, false);
});

test("an audience response without num_received is unknown", async () => {
  stubFetch({ json: { audience_id: "9876543210" } });
  const outcome = await new MetaSuppressionAdapter(config()).addToExclusionAudience({
    idempotencyKey: "k",
    subject: subject(),
    dryRun: false,
  });
  assert.equal(outcome.kind, "unknown");
  assert.equal(outcome.failure?.retryable, true);
});

test("a subject with no supported identifier is refused rather than sent empty", async () => {
  const calls = stubFetch({ json: { num_received: 1 } });
  const outcome = await new MetaSuppressionAdapter(config()).addToExclusionAudience({
    idempotencyKey: "k",
    subject: new PlatformSubject({ external_id: "1".repeat(64) }),
    dryRun: false,
  });
  assert.equal(calls.length, 0);
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.failure?.code, "META_NO_USABLE_IDENTIFIER");
});

test("the session id is stable per key and within the documented range", () => {
  assert.equal(sessionId("a"), sessionId("a"));
  assert.notEqual(sessionId("a"), sessionId("b"));
  assert.equal(Number.isInteger(sessionId("a")), true);
  assert.equal(sessionId("a") >= 0 && sessionId("a") < 2_147_483_647, true);
});

test("exclusion coverage counts both documented audience id forms", async () => {
  const calls = stubFetch({
    json: {
      data: [
        { id: "100", targeting: { excluded_custom_audiences: [{ id: "9876543210" }] } },
        { id: "200", targeting: { excluded_custom_audiences: [9876543210] } },
      ],
    },
  });
  const outcome = await new MetaSuppressionAdapter(config()).verifyExclusionConfiguration({
    idempotencyKey: "k",
    dryRun: false,
  });
  assert.equal(calls[0].url.startsWith("https://graph.example.invalid/v25.0/act_555000111/adsets?"), true);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(outcome.kind, "processed");
  assert.deepEqual(outcome.coverage, { targeted: 2, observed: 2, excluding: 2, unresolved: [] });
  assert.match(outcome.configurationDigest ?? "", /^[0-9a-f]{64}$/);
});

test("partial coverage is reported as a fraction rather than collapsed to a verdict", async () => {
  stubFetch({
    json: {
      data: [
        { id: "100", targeting: { excluded_custom_audiences: [{ id: "9876543210" }] } },
        { id: "200", targeting: { excluded_custom_audiences: [] } },
      ],
    },
  });
  const outcome = await new MetaSuppressionAdapter(config()).verifyExclusionConfiguration({
    idempotencyKey: "k",
    dryRun: false,
  });
  assert.deepEqual(outcome.coverage, { targeted: 2, observed: 2, excluding: 1, unresolved: [] });
  assert.equal(outcome.kind, "processed");
  assert.equal(exclusionIsComplete(outcome.coverage), false);
});

test("an ad account id without the act_ prefix is normalised", async () => {
  const calls = stubFetch({ json: { data: [] } });
  await new MetaSuppressionAdapter(config({ adAccountId: "555000111" })).verifyExclusionConfiguration({
    idempotencyKey: "k",
    dryRun: false,
  });
  assert.equal(calls[0].url.includes("/act_555000111/adsets"), true);
});

test("the exclusion check never writes targeting", async () => {
  const calls = stubFetch({ json: { data: [] } });
  await new MetaSuppressionAdapter(config()).verifyExclusionConfiguration({ idempotencyKey: "k", dryRun: false });
  for (const call of calls) assert.equal(call.init.method, "GET");
});

test("documented throttle and transient codes are retryable and reported as unknown", () => {
  for (const code of [4, 17, 341]) {
    const outcome = classify(400, { error: { code } });
    assert.equal(outcome.failure?.class, "throttle", `code ${code}`);
    assert.equal(outcome.failure?.retryable, true);
    assert.equal(outcome.kind, "unknown");
  }
  for (const code of [1, 2, 368]) {
    const outcome = classify(400, { error: { code } });
    assert.equal(outcome.failure?.class, "transient", `code ${code}`);
    assert.equal(outcome.failure?.retryable, true);
  }
});

test("credential and permission failures are permanent", () => {
  for (const code of [10, 102, 190, 200, 299]) {
    const outcome = classify(400, { error: { code } });
    assert.equal(outcome.failure?.class, "authorisation", `code ${code}`);
    assert.equal(outcome.failure?.retryable, false);
    assert.equal(outcome.kind, "rejected");
  }
});

test("transport-level throttling and outages are retryable", () => {
  assert.equal(classify(429, undefined).failure?.retryable, true);
  assert.equal(classify(429, undefined).failure?.class, "throttle");
  assert.equal(classify(503, undefined).failure?.retryable, true);
  assert.equal(classify(500, {}).failure?.class, "transient");
});

test("an unrecognised error is permanent rather than retried against an advertiser account", () => {
  const outcome = classify(400, { error: { code: 99999, message: "something new" } });
  assert.equal(outcome.failure?.retryable, false);
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.failure?.code, "META_400_99999");
});

test("the failure carries the trace id and no message text", () => {
  const outcome = classify(400, {
    error: { code: 190, message: "Error validating access token: EAA-secret-token-value", fbtrace_id: "Atrace" },
  });
  assert.equal(outcome.platformRef, "Atrace");
  assert.equal(JSON.stringify(outcome).includes(TOKEN), false);
});

test("no outcome from any path carries the access token", async () => {
  const outcomes: unknown[] = [];
  stubFetch({ status: 400, json: { error: { code: 190, message: `bad token ${TOKEN}` } } });
  const adapter = new MetaSuppressionAdapter(config());
  outcomes.push(await adapter.sendConversion(conversion()));
  outcomes.push(
    await adapter.addToExclusionAudience({ idempotencyKey: "k", subject: subject(), dryRun: false }),
  );
  outcomes.push(await adapter.verifyExclusionConfiguration({ idempotencyKey: "k", dryRun: false }));
  assert.equal(JSON.stringify(outcomes).includes(TOKEN), false);
});

test("the default pin is a stable version rather than whatever is newest", async () => {
  const previous = process.env.META_GRAPH_API_VERSION;
  delete process.env.META_GRAPH_API_VERSION;
  const { metaConfigFromProcess } = await import("./meta.ts");
  assert.equal(metaConfigFromProcess().apiVersion, "v25.0");
  if (previous !== undefined) process.env.META_GRAPH_API_VERSION = previous;
});
