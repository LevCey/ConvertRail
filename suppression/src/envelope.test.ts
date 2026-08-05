import { strict as assert } from "node:assert";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJSON } from "@convertrail/shared";
import { ENVELOPE_VERSION, envelopePreimage, openEnvelope, signEnvelope } from "./envelope.ts";
import type { EnvelopeBody, EnvelopeWire } from "./envelope.ts";
import { PlatformSubject } from "./types.ts";

const merchant = privateKeyToAccount(`0x${"51".repeat(32)}`);
const impostor = privateKeyToAccount(`0x${"52".repeat(32)}`);

const EVIDENCE = `0x${"cd".repeat(32)}` as const;
const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const EM = "a".repeat(64);

function body(overrides: Partial<EnvelopeBody> = {}): EnvelopeBody {
  return {
    version: ENVELOPE_VERSION,
    evidenceHash: EVIDENCE,
    subjectRef: "subj_017",
    subject: { em: EM },
    occurredAt: "2026-08-04T11:58:00.000Z",
    order: { value: "49.99", currency: "USD" },
    consent: { granted: true, purpose: "advertising-suppression", recordedAt: "2026-08-04T11:59:00.000Z" },
    expiresAt: "2026-08-04T12:05:00.000Z",
    ...overrides,
  };
}

const opts = { merchant: merchant.address, evidenceHash: EVIDENCE, nowMs: NOW };

test("a well-formed envelope opens and yields a non-serialisable subject", async () => {
  const wire = await signEnvelope(body(), merchant);
  const result = await openEnvelope(wire, opts);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.envelope.subjectRef, "subj_017");
  assert.equal(result.ok && result.envelope.subject instanceof PlatformSubject, true);
  assert.throws(() => JSON.stringify(result.ok && result.envelope), /must not be serialised/);
});

test("the envelope preimage is disjoint from a bare conversion-event preimage", () => {
  const b = body();
  assert.equal(envelopePreimage(b).startsWith("ConvertRail Suppression Envelope v1\n"), true);
  assert.notEqual(envelopePreimage(b), canonicalJSON(b));
});

test("a signature from anyone but the expected merchant is refused", async () => {
  const wire = await signEnvelope(body(), impostor);
  const result = await openEnvelope(wire, opts);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "envelope was not signed by the expected merchant");
});

test("an envelope for a different claim is refused even when correctly signed", async () => {
  const wire = await signEnvelope(body({ evidenceHash: `0x${"ff".repeat(32)}` }), merchant);
  const result = await openEnvelope(wire, opts);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "envelope is bound to a different claim");
});

test("every signed field is bound: mutating any of them breaks the envelope", async () => {
  const wire = await signEnvelope(body(), merchant);
  const mutations: Array<Partial<EnvelopeWire>> = [
    { subjectRef: "subj_999" },
    { subject: { em: "b".repeat(64) } },
    { consent: { granted: false, purpose: "advertising-suppression", recordedAt: "2026-08-04T11:59:00.000Z" } },
    { expiresAt: "2026-08-04T12:04:00.000Z" },
  ];
  for (const mutation of mutations) {
    const result = await openEnvelope({ ...wire, ...mutation }, opts);
    assert.equal(result.ok, false, `mutation ${Object.keys(mutation)[0]} must not open`);
  }
});

test("consent is carried through rather than treated as an error", async () => {
  const wire = await signEnvelope(
    body({ consent: { granted: false, purpose: "advertising-suppression", recordedAt: "2026-08-04T11:59:00.000Z" } }),
    merchant,
  );
  const result = await openEnvelope(wire, opts);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.envelope.consent.granted, false);
});

test("an expired envelope does not open", async () => {
  const wire = await signEnvelope(body({ expiresAt: "2026-08-04T11:59:59.999Z" }), merchant);
  const result = await openEnvelope(wire, opts);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "envelope has expired");
});

test("an unhashed identifier is refused rather than forwarded to a platform", async () => {
  const wire = await signEnvelope(body({ subject: { em: "buyer@example.com" } }), merchant);
  const result = await openEnvelope(wire, opts);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /not a normalised hash/);
});

test("an uppercase hash is refused, since the platform hash is defined as lowercase", async () => {
  const wire = await signEnvelope(body({ subject: { em: "A".repeat(64) } }), merchant);
  assert.equal((await openEnvelope(wire, opts)).ok, false);
});

test("an unknown identifier kind is refused", async () => {
  const wire = await signEnvelope(body({ subject: { em: EM, ssn: "1".repeat(64) } }), merchant);
  const result = await openEnvelope(wire, opts);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /unsupported identifier kind ssn/);
});

test("an empty subject is refused", async () => {
  const wire = await signEnvelope(body({ subject: {} }), merchant);
  assert.equal((await openEnvelope(wire, opts)).ok, false);
});

test("malformed input is rejected without throwing", async () => {
  const cases: unknown[] = [
    null,
    "not an object",
    {},
    { version: "other" },
    { version: ENVELOPE_VERSION, evidenceHash: "0xdead" },
  ];
  for (const wire of cases) {
    const result = await openEnvelope(wire, opts);
    assert.equal(result.ok, false);
  }
});

test("an unsigned envelope is refused", async () => {
  const result = await openEnvelope(body(), opts);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "malformed merchant signature");
});

test("appending an unsigned field breaks the signature rather than being ignored", async () => {
  const wire = await signEnvelope(body(), merchant);
  const result = await openEnvelope({ ...wire, extra: "smuggled" }, opts);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "envelope was not signed by the expected merchant");
});

test("no rejection reason repeats an identifier back to the caller", async () => {
  const wire = await signEnvelope(body({ subject: { em: "buyer@example.com" } }), merchant);
  const result = await openEnvelope(wire, opts);
  assert.equal(result.ok === false && result.reason.includes("buyer@example.com"), false);
});

test("consent recorded for another purpose does not authorise a suppression", async () => {
  for (const purpose of ["newsletter", "analytics", "advertising", ""]) {
    const wire = await signEnvelope(
      body({ consent: { granted: true, purpose, recordedAt: "2026-08-04T11:59:00.000Z" } }),
      merchant,
    );
    const result = await openEnvelope(wire, opts);
    assert.equal(result.ok, false, `purpose ${JSON.stringify(purpose)} must not open`);
    assert.equal(
      result.ok === false && result.reason,
      "consent was not recorded for advertising suppression",
    );
  }
});

test("a malformed or future consent timestamp is refused", async () => {
  const malformed = await signEnvelope(
    body({ consent: { granted: true, purpose: "advertising-suppression", recordedAt: "yesterday" } }),
    merchant,
  );
  assert.match(
    (await openEnvelope(malformed, opts)).ok === false
      ? ((await openEnvelope(malformed, opts)) as { reason: string }).reason
      : "",
    /malformed consent timestamp/,
  );

  const future = await signEnvelope(
    body({
      consent: {
        granted: true,
        purpose: "advertising-suppression",
        recordedAt: new Date(NOW + 120_000).toISOString(),
      },
    }),
    merchant,
  );
  const result = await openEnvelope(future, opts);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /consent timestamp is in the future/);
});

test("a small clock skew on consent is tolerated rather than rejected", async () => {
  const wire = await signEnvelope(
    body({
      consent: {
        granted: true,
        purpose: "advertising-suppression",
        recordedAt: new Date(NOW + 5_000).toISOString(),
      },
    }),
    merchant,
  );
  assert.equal((await openEnvelope(wire, opts)).ok, true);
});

test("the conversion timestamp must be present, parseable and not in the future", async () => {
  const missing = await signEnvelope({ ...body(), occurredAt: "not a date" }, merchant);
  assert.match(
    ((await openEnvelope(missing, opts)) as { reason: string }).reason,
    /malformed conversion timestamp/,
  );

  const ahead = await signEnvelope(body({ occurredAt: new Date(NOW + 120_000).toISOString() }), merchant);
  assert.match(
    ((await openEnvelope(ahead, opts)) as { reason: string }).reason,
    /conversion timestamp is in the future/,
  );
});

test("the conversion timestamp reaches the caller unchanged", async () => {
  const wire = await signEnvelope(body({ occurredAt: "2026-08-04T11:30:00.000Z" }), merchant);
  const result = await openEnvelope(wire, opts);
  assert.equal(result.ok && result.envelope.occurredAt, "2026-08-04T11:30:00.000Z");
});

test("an order value that is not major units with an ISO currency is refused", async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ value: "4999000000", currency: "USDC" }, /ISO 4217/],
    [{ value: "49.99", currency: "USDC" }, /ISO 4217/],
    [{ value: "49.99", currency: "usd" }, /ISO 4217/],
    [{ value: "49.999", currency: "USD" }, /major units/],
    [{ value: "-1", currency: "USD" }, /major units/],
    [{ value: 49.99, currency: "USD" }, /major units/],
    [{ currency: "USD" }, /major units/],
    ["49.99 USD", /malformed order value/],
  ];
  for (const [order, expected] of cases) {
    const wire = await signEnvelope({ ...body(), order: order as never }, merchant);
    const result = await openEnvelope(wire, opts);
    assert.equal(result.ok, false, `order ${JSON.stringify(order)} must not open`);
    assert.match(result.ok === false ? result.reason : "", expected);
  }
});

test("an absent order must be explicit null, not a missing field", async () => {
  const explicit = await signEnvelope({ ...body(), order: null }, merchant);
  const opened = await openEnvelope(explicit, opts);
  assert.equal(opened.ok, true);
  assert.equal(opened.ok && opened.envelope.order, null);

  const { order, ...withoutOrder } = body();
  const implicit = await signEnvelope(withoutOrder as never, merchant);
  assert.equal((await openEnvelope(implicit, opts)).ok, false);
});

test("an atomic-unit amount cannot reach a platform as a purchase value", async () => {
  const wire = await signEnvelope({ ...body(), order: { value: "1000", currency: "USDC" } }, merchant);
  const result = await openEnvelope(wire, opts);
  assert.equal(result.ok, false);
});
