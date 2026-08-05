import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  REDACTED,
  assertSafeToPersist,
  digest,
  redactOutcome,
  scrub,
  subjectCommitment,
} from "./redaction.ts";
import { PlatformSubject } from "./types.ts";

const KEY = "k".repeat(48);
const EMAIL_HASH = "9".repeat(64);

test("a subject refuses to serialise", () => {
  const subject = new PlatformSubject({ em: EMAIL_HASH });
  assert.throws(() => JSON.stringify({ subject }), /must not be serialised/);
  assert.throws(() => JSON.stringify(subject), /must not be serialised/);
});

test("a subject prints redacted rather than leaking through a template", () => {
  const subject = new PlatformSubject({ em: EMAIL_HASH, ph: "7".repeat(64) });
  assert.equal(`${subject}`, "[PlatformSubject redacted]");
  assert.deepEqual(subject.presentKinds(), ["em", "ph"]);
  assert.equal(subject.presentKinds().join(",").includes(EMAIL_HASH), false);
});

test("a subject requires at least one identifier", () => {
  assert.throws(() => new PlatformSubject({}), /at least one identifier/);
  assert.throws(() => new PlatformSubject({ em: "" }), /at least one identifier/);
});

test("only forPlatform reveals the values", () => {
  const subject = new PlatformSubject({ em: EMAIL_HASH });
  assert.deepEqual(subject.forPlatform(), { em: EMAIL_HASH });
});

test("the commitment is keyed, so it is not the platform hash", () => {
  const commitment = subjectCommitment(KEY, "tenant-a", "subj_1");
  assert.notEqual(commitment, EMAIL_HASH);
  assert.match(commitment, /^[0-9a-f]{64}$/);
});

test("the commitment is tenant-scoped and unlinkable across tenants", () => {
  const a = subjectCommitment(KEY, "tenant-a", "subj_1");
  const b = subjectCommitment(KEY, "tenant-b", "subj_1");
  assert.notEqual(a, b);
  assert.equal(a, subjectCommitment(KEY, "tenant-a", "subj_1"));
});

test("tenant and subject cannot be shifted across the boundary to collide", () => {
  assert.notEqual(subjectCommitment(KEY, "a", "b c"), subjectCommitment(KEY, "a b", "c"));
});

test("a short commitment key is rejected", () => {
  assert.throws(() => subjectCommitment("short", "t", "s"), /at least 32 characters/);
});

test("scrub removes identifiers by key name and by value shape", () => {
  const scrubbed = scrub({
    em: EMAIL_HASH,
    note: "contact buyer@example.com about this",
    stray: EMAIL_HASH,
    nested: { ph: "+447700900123", ok: "fine" },
    count: 3,
  }) as Record<string, unknown>;
  assert.equal(scrubbed.em, REDACTED);
  assert.equal(scrubbed.note, REDACTED);
  assert.equal(scrubbed.stray, REDACTED);
  assert.deepEqual(scrubbed.nested, { ph: REDACTED, ok: "fine" });
  assert.equal(scrubbed.count, 3);
});

test("scrub replaces a subject instance wherever it appears", () => {
  const scrubbed = scrub({ payload: new PlatformSubject({ em: EMAIL_HASH }) }) as Record<string, unknown>;
  assert.equal(scrubbed.payload, REDACTED);
});

test("digest is stable under key reordering", () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
});

test("a redacted outcome keeps the classification and drops the payload", () => {
  const redacted = redactOutcome({
    kind: "accepted",
    platformRef: "ref_1",
    detail: { em: EMAIL_HASH, currency: "USDC" },
    failure: undefined,
  });
  assert.equal(redacted.kind, "accepted");
  assert.equal(redacted.platformRef, "ref_1");
  assert.deepEqual(redacted.detail, { em: REDACTED, currency: "USDC" });
  assert.match(redacted.responseDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(redacted).includes(EMAIL_HASH), false);
});

test("the persist gate rejects an email, a phone and an undeclared hash", () => {
  assert.throws(() => assertSafeToPersist({ note: "a@b.co" }, "t"), /email-shaped/);
  assert.throws(() => assertSafeToPersist({ note: "+447700900123" }, "t"), /phone-shaped/);
  assert.throws(() => assertSafeToPersist({ blob: EMAIL_HASH }, "t"), /undeclared 64-hex/);
});

test("the persist gate names the path so the leak can be traced", () => {
  assert.throws(
    () => assertSafeToPersist({ outer: { list: [{ blob: EMAIL_HASH }] } }, "t"),
    /\$\.outer\.list\[0\]\.blob/,
  );
});

test("the persist gate allows hex only at declared fields", () => {
  assert.doesNotThrow(() =>
    assertSafeToPersist({ subjectCommitment: EMAIL_HASH, responseDigest: EMAIL_HASH }, "t"),
  );
  assert.throws(() => assertSafeToPersist({ subjectComitment: EMAIL_HASH }, "t"), /undeclared/);
});

test("the persist gate rejects an unredacted sensitive key and a live subject", () => {
  assert.throws(() => assertSafeToPersist({ email: "someone" }, "t"), /sensitive key "email"/);
  assert.doesNotThrow(() => assertSafeToPersist({ email: REDACTED }, "t"));
  assert.throws(
    () => assertSafeToPersist({ s: new PlatformSubject({ em: EMAIL_HASH }) }, "t"),
    /platform identifiers/,
  );
});

test("scrubbed adapter detail passes the persist gate", () => {
  const redacted = redactOutcome({
    kind: "rejected",
    detail: { em: EMAIL_HASH, reason: "unknown field" },
    failure: { class: "validation", code: "INVALID", retryable: false },
  });
  assert.doesNotThrow(() => assertSafeToPersist(redacted, "t"));
});
