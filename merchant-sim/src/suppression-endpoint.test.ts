import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { openEnvelope } from "../../suppression/src/envelope.ts";
import { handleSuppressionSubject, tokenAccepted } from "./suppression-endpoint.ts";
import { normaliseEmail, normalisePhone, platformIdentifiers, syntheticBuyer } from "./synthetic-identity.ts";
import type { SubjectRecord } from "./suppression-endpoint.ts";

const merchant = privateKeyToAccount(`0x${"51".repeat(32)}`);
const EVIDENCE = `0x${"cd".repeat(32)}` as const;
const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const TOKEN = "t".repeat(40);

const record: SubjectRecord = { conversionId: "c-42", conversionTs: NOW - 1000 };
const lookup = (hash: string) => (hash === EVIDENCE ? record : undefined);
const config = { token: TOKEN, ttlMs: 300_000, now: () => NOW };

test("an unauthenticated caller gets nothing", async () => {
  for (const header of [undefined, "", "Bearer wrong", `Bearer ${TOKEN} `, TOKEN.slice(0, -1)]) {
    const response = await handleSuppressionSubject(EVIDENCE, header, lookup, merchant, config);
    assert.equal(response.status, 401, `header ${JSON.stringify(header)} must not be accepted`);
    assert.deepEqual(response.body, { error: "unauthorized" });
  }
});

test("an unconfigured token closes the endpoint rather than opening it", async () => {
  const response = await handleSuppressionSubject(EVIDENCE, `Bearer ${TOKEN}`, lookup, merchant, {
    ...config,
    token: "",
  });
  assert.equal(response.status, 503);
});

test("a bare token is accepted as well as a Bearer prefix", () => {
  assert.equal(tokenAccepted(TOKEN, TOKEN), true);
  assert.equal(tokenAccepted(TOKEN, `Bearer ${TOKEN}`), true);
  assert.equal(tokenAccepted(TOKEN, `bearer ${TOKEN}`), true);
  assert.equal(tokenAccepted(TOKEN, `${TOKEN}x`), false);
  assert.equal(tokenAccepted("", ""), false);
});

test("an unknown evidence hash is a 404, not an envelope for someone else", async () => {
  const response = await handleSuppressionSubject(
    `0x${"11".repeat(32)}`,
    `Bearer ${TOKEN}`,
    lookup,
    merchant,
    config,
  );
  assert.equal(response.status, 404);
});

test("an authorised caller gets an envelope that opens against the merchant address", async () => {
  const response = await handleSuppressionSubject(EVIDENCE, `Bearer ${TOKEN}`, lookup, merchant, config);
  assert.equal(response.status, 200);
  const opened = await openEnvelope(response.body, {
    merchant: merchant.address,
    evidenceHash: EVIDENCE,
    nowMs: NOW,
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.ok && opened.envelope.evidenceHash, EVIDENCE);
});

test("the envelope expires within the configured window", async () => {
  const response = await handleSuppressionSubject(EVIDENCE, `Bearer ${TOKEN}`, lookup, merchant, config);
  const expiresAt = Date.parse((response.body as { expiresAt: string }).expiresAt);
  assert.equal(expiresAt, NOW + 300_000);
  const late = await openEnvelope(response.body, {
    merchant: merchant.address,
    evidenceHash: EVIDENCE,
    nowMs: NOW + 300_001,
  });
  assert.equal(late.ok, false);
});

test("the response carries hashes only, never a raw contact detail", async () => {
  const response = await handleSuppressionSubject(EVIDENCE, `Bearer ${TOKEN}`, lookup, merchant, config);
  const serialised = JSON.stringify(response.body);
  const buyer = syntheticBuyer(record.conversionId);
  assert.equal(serialised.includes(buyer.email), false);
  assert.equal(serialised.includes(buyer.phone), false);
  assert.equal(serialised.includes("@"), false);
});

test("synthetic buyers are deterministic and drawn from unroutable ranges", () => {
  const buyer = syntheticBuyer("c-42");
  assert.deepEqual(buyer, syntheticBuyer("c-42"));
  assert.match(buyer.email, /@synthetic\.invalid$/);
  assert.match(buyer.phone, /^\+44770090[0-9]{4}$/);
});

test("buyers repeat across conversions, so the returning-purchaser case is covered", () => {
  const refs = new Set(Array.from({ length: 400 }, (_, i) => syntheticBuyer(`c-${i}`).subjectRef));
  assert.equal(refs.size < 400, true);
  assert.equal(refs.size > 1, true);
});

test("some buyers withhold consent, so the skip path is reachable", () => {
  const consents = Array.from({ length: 400 }, (_, i) => syntheticBuyer(`c-${i}`).consentGranted);
  assert.equal(consents.some((c) => c === false), true);
  assert.equal(consents.some((c) => c === true), true);
});

test("normalisation follows the lowercase-and-trim rule platforms specify", () => {
  assert.equal(normaliseEmail("  Buyer.7@Synthetic.INVALID "), normaliseEmail("buyer.7@synthetic.invalid"));
  assert.match(normaliseEmail("buyer.7@synthetic.invalid"), /^[0-9a-f]{64}$/);
});

test("phone normalisation strips formatting and rejects an implausible number", () => {
  assert.equal(normalisePhone("+44 7700 900042"), normalisePhone("447700900042"));
  assert.throws(() => normalisePhone("+44 77"), /implausibly short/);
});

test("platform identifiers are hashes of the three supported kinds", () => {
  const identifiers = platformIdentifiers(syntheticBuyer("c-42"));
  assert.deepEqual(Object.keys(identifiers).sort(), ["em", "external_id", "ph"]);
  for (const value of Object.values(identifiers)) assert.match(value, /^[0-9a-f]{64}$/);
});

test("every response, including the refusals, forbids caching and varies on the credential", async () => {
  const cases = [
    await handleSuppressionSubject(EVIDENCE, undefined, lookup, merchant, config),
    await handleSuppressionSubject(EVIDENCE, `Bearer ${TOKEN}`, lookup, merchant, { ...config, token: "" }),
    await handleSuppressionSubject(`0x${"11".repeat(32)}`, `Bearer ${TOKEN}`, lookup, merchant, config),
    await handleSuppressionSubject(EVIDENCE, `Bearer ${TOKEN}`, lookup, merchant, config),
  ];
  for (const response of cases) {
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers.vary, "Authorization");
  }
});

test("the envelope carries the merchant's conversion time, not the time it was served", async () => {
  const response = await handleSuppressionSubject(EVIDENCE, `Bearer ${TOKEN}`, lookup, merchant, config);
  const body = response.body as { occurredAt: string };
  assert.equal(body.occurredAt, new Date(record.conversionTs).toISOString());
  assert.notEqual(Date.parse(body.occurredAt), NOW);
});

test("consent is recorded for the exact suppression purpose", async () => {
  const response = await handleSuppressionSubject(EVIDENCE, `Bearer ${TOKEN}`, lookup, merchant, config);
  const body = response.body as { consent: { purpose: string; recordedAt: string } };
  assert.equal(body.consent.purpose, "advertising-suppression");
  assert.equal(Number.isNaN(Date.parse(body.consent.recordedAt)), false);
});

test("a merchant that models no order value says so rather than inventing one", async () => {
  const response = await handleSuppressionSubject(EVIDENCE, `Bearer ${TOKEN}`, lookup, merchant, config);
  assert.equal((response.body as { order: unknown }).order, null);
});

test("a merchant order value is carried through in major units with an ISO currency", async () => {
  const withOrder = { ...record, order: { value: "49.99", currency: "USD" } };
  const response = await handleSuppressionSubject(
    EVIDENCE,
    `Bearer ${TOKEN}`,
    () => withOrder,
    merchant,
    config,
  );
  assert.deepEqual((response.body as { order: unknown }).order, { value: "49.99", currency: "USD" });
  const opened = await openEnvelope(response.body, {
    merchant: merchant.address,
    evidenceHash: EVIDENCE,
    nowMs: NOW,
  });
  assert.equal(opened.ok, true);
});

test("a signing failure returns 500 with the privacy headers, never a bare error", async () => {
  const brokenMerchant = {
    ...merchant,
    signMessage: async () => {
      throw new Error("signer unavailable");
    },
  } as unknown as typeof merchant;

  const response = await handleSuppressionSubject(
    EVIDENCE,
    `Bearer ${TOKEN}`,
    lookup,
    brokenMerchant,
    config,
  );
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "could not build envelope" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.vary, "Authorization");
});

test("the handler resolves on every path, so the server has no header-free branch", async () => {
  const brokenMerchant = {
    ...merchant,
    signMessage: async () => {
      throw new Error("signer unavailable");
    },
  } as unknown as typeof merchant;
  // Would previously have rejected and fallen into the server's bare-500 branch.
  await assert.doesNotReject(() =>
    handleSuppressionSubject(EVIDENCE, `Bearer ${TOKEN}`, lookup, brokenMerchant, config),
  );
});

test("a failure discloses nothing about the buyer it could not serve", async () => {
  const brokenMerchant = {
    ...merchant,
    signMessage: async () => {
      throw new Error(`signer unavailable for ${syntheticBuyer(record.conversionId).email}`);
    },
  } as unknown as typeof merchant;
  const response = await handleSuppressionSubject(
    EVIDENCE,
    `Bearer ${TOKEN}`,
    lookup,
    brokenMerchant,
    config,
  );
  const serialised = JSON.stringify(response.body);
  assert.equal(serialised.includes("@"), false);
  assert.equal(serialised.includes(syntheticBuyer(record.conversionId).subjectRef), false);
});

test("the server applies the privacy headers before entering the handler", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const routeAt = source.indexOf("suppression-subject");
  const headersAt = source.indexOf("PRIVACY_HEADERS", routeAt);
  const handlerAt = source.indexOf("handleSuppressionSubject(", routeAt);
  assert.equal(headersAt > -1 && headersAt < handlerAt, true, "headers must be set first");
});
