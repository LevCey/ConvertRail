import { canonicalJSON } from "@convertrail/shared";
import { createHmac, createHash } from "node:crypto";
import { PlatformSubject, type ExclusionCoverage } from "./types.ts";
import type { AdapterOutcome } from "./adapters/types.ts";

/**
 * The single path from adapter data to anything durable — a log line, a store
 * record, a receipt field. Nothing else in the module is permitted to write
 * adapter output directly.
 *
 * The rule this enforces: a hashed email is still personal data. It is stable,
 * unkeyed and identical across every advertiser, so writing one into a log
 * turns that log into a cross-advertiser identity join. Everything leaving here
 * is either a keyed commitment, a digest of a structure, or a value we have
 * decided is safe by inspection.
 */

/** Key names that suggest the value is, or contains, an identifier. */
const SENSITIVE_KEY =
  /(^|_)(em|ph|email|phone|mail|msisdn|tel|external_id|externalid|fn|ln|subject|identifier|token|secret|key|authorization|access_token|passwd|password)($|_)/i;

/** 64 hex characters standing alone: the shape of a SHA-256 contact hash. */
const BARE_SHA256 = /\b[0-9a-f]{64}\b/i;

const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** Loose enough to catch E.164 and the digit-run forms a platform might echo. */
const PHONE_LIKE = /(?:^|\s)\+?\d{10,15}(?=\s|$)/;

export const REDACTED = "[redacted]";

/**
 * Keyed commitment to a subject, safe to publish on a receipt.
 *
 * Deliberately not the platform's SHA-256. That value is a global identifier —
 * anyone with the same email derives it. This is HMAC'd with a per-tenant key
 * that never leaves the operator, so a receipt proves "the same buyer" within
 * one advertiser's records and proves nothing at all outside them. Losing the
 * key loses linkability, which is the correct failure direction.
 */
export function subjectCommitment(
  commitmentKey: string,
  tenantId: string,
  subjectRef: string,
): string {
  return keyedDigest(commitmentKey, "subject-commitment", tenantId, subjectRef);
}

/**
 * Keyed fingerprint over the envelope fields execution actually depends on.
 *
 * The commitment alone is not enough to detect a swapped envelope. Two
 * envelopes can share a `subjectRef` and carry different platform identifiers,
 * a different purchase time, a different order or different consent — and the
 * platform would receive the second while the receipt still named the first.
 * This covers every field a downstream call reads, so a refetch that differs in
 * any of them is caught before another request goes out.
 *
 * The identifiers go in as HMAC input and never come out: the result is a keyed
 * digest, so the journal records that the envelope was the same one without
 * storing anything derived from a buyer that another party could recompute.
 */
export function envelopeFingerprint(
  commitmentKey: string,
  tenantId: string,
  envelope: {
    subjectRef: string;
    subject: PlatformSubject;
    occurredAt: string;
    order: { value: string; currency: string } | null;
    consent: { granted: boolean; purpose: string; recordedAt: string };
  },
): string {
  const identifiers = envelope.subject.forPlatform();
  const sorted = Object.keys(identifiers)
    .sort()
    .flatMap((kind) => [kind, identifiers[kind] as string]);
  return keyedDigest(
    commitmentKey,
    "envelope-fingerprint",
    tenantId,
    envelope.subjectRef,
    envelope.occurredAt,
    envelope.order === null ? "no-order" : `${envelope.order.value} ${envelope.order.currency}`,
    String(envelope.consent.granted),
    envelope.consent.purpose,
    envelope.consent.recordedAt,
    ...sorted,
  );
}

/**
 * One key derives both the commitment and the fingerprint, so the two are
 * domain-separated. Without the tag a fingerprint over one input set could
 * collide with a commitment over another, and a check comparing the wrong pair
 * would pass.
 */
function keyedDigest(commitmentKey: string, domain: string, ...parts: string[]): string {
  if (commitmentKey.length < 32) {
    throw new Error("commitment key must be at least 32 characters");
  }
  return createHmac("sha256", commitmentKey)
    .update(lengthPrefixed(`convertrail:suppression:${domain}:v1`, ...parts))
    .digest("hex");
}

/**
 * Unambiguous encoding of the commitment inputs.
 *
 * Plain concatenation with a separator is not injective: with a space, tenant
 * `a` and subject `b c` collide with tenant `a b` and subject `c`, so one
 * tenant could produce another's commitment for a buyer it never saw. Prefixing
 * each component with its byte length removes the ambiguity for any content.
 */
function lengthPrefixed(...parts: string[]): string {
  return parts.map((p) => `${Buffer.byteLength(p, "utf8")}:${p}`).join("");
}

/** Stable digest over a structure, via the project's canonical serialisation so
 * key order can never change the result. */
export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}

/**
 * Reduce an adapter response to something storable: outcome shape, failure
 * classification, and a digest that commits to the full detail without
 * revealing it. A dispute can be settled by re-deriving the digest from a
 * retained raw response; day-to-day storage never holds one.
 */
export function redactOutcome(outcome: RedactableOutcome): RedactedOutcome {
  const core = {
    kind: outcome.kind,
    platformRef: outcome.platformRef ?? null,
    detail: scrub(outcome.detail),
    failure: outcome.failure ?? null,
    // Counts of an advertiser's own ad sets and a digest of their configuration.
    // Neither describes a person, and both are what the coverage figure on a
    // receipt has to be traceable to.
    coverage: outcome.coverage ?? null,
    configurationDigest: outcome.configurationDigest ?? null,
  };
  return { ...core, responseDigest: digest(core) };
}

export type RedactableOutcome = AdapterOutcome & {
  coverage?: ExclusionCoverage | undefined;
  configurationDigest?: string | undefined;
};

export interface RedactedOutcome {
  kind: string;
  platformRef: string | null;
  detail: unknown;
  failure: AdapterOutcome["failure"] | null;
  coverage: ExclusionCoverage | null;
  configurationDigest: string | null;
  responseDigest: string;
}

/**
 * Recursively replace anything that is, or might be, an identifier.
 *
 * Both a key-name rule and a value-shape rule, because either alone misses
 * cases: a platform can return a hash under an unremarkable key, and a
 * sensitive key can hold a harmless value. Erring toward over-redaction is
 * correct here — a redacted diagnostic costs an investigation some time, a
 * leaked one is unrecoverable.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (value === null || value === undefined) return null;
  if (value instanceof PlatformSubject) return REDACTED;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrub(v, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

function scrubString(value: string): string {
  if (EMAIL_LIKE.test(value)) return REDACTED;
  if (BARE_SHA256.test(value)) return REDACTED;
  if (PHONE_LIKE.test(value)) return REDACTED;
  return value.length > 512 ? `${value.slice(0, 512)}…` : value;
}

/**
 * Fields whose values are known not to be personal data.
 *
 * A keyed HMAC commitment, a structural digest and an unkeyed SHA-256 of an
 * email are the same 64 characters; a platform object id and a phone number are
 * both digit runs. Shape cannot separate them, so the persist gate does not
 * try. It exempts only paths whose derivation is known and reviewed here, and
 * rejects the shape everywhere else. Adding a name to this set is a privacy
 * decision and should be treated as one.
 */
const DECLARED_NON_PII_FIELDS = new Set([
  // Derived values: HMAC commitments and structural digests.
  "subjectCommitment",
  // Keyed digest over the envelope. Takes buyer identifiers as HMAC input and
  // emits nothing derivable from them without the tenant key, so it records
  // sameness without recording the buyer.
  "envelopeFingerprint",
  "responseDigest",
  "exclusionConfigurationHash",
  "configurationDigest",
  "receiptDigest",
  "bodyDigest",
  // Chain-side values, already public.
  "evidenceHash",
  "campaignId",
  "claimId",
  // Platform object ids: identify an advertiser's own configuration, not a person.
  "platformRef",
  "pixelId",
  "datasetId",
  "audienceId",
  "adAccountId",
  "eventId",
]);

/**
 * Last line of defence before anything is appended to disk or emitted as a log.
 *
 * Runs over the raw record, not a scrubbed copy — scrubbing first would make
 * the check vacuous. Throws rather than cleaning up: reaching here with an
 * identifier means an earlier control failed, and quietly fixing it would hide
 * the defect that let it through.
 */
export function assertSafeToPersist(record: unknown, where: string): void {
  const offence = findIdentifier(record, "$", 0);
  if (offence) throw new Error(`${where}: refusing to persist, ${offence}`);
}

/** Trailing property name of a `$.a.b[0].c` path, ignoring array indices. */
function leafName(path: string): string {
  const withoutIndex = path.replace(/\[\d+\]$/, "");
  return withoutIndex.slice(withoutIndex.lastIndexOf(".") + 1);
}

function findIdentifier(value: unknown, path: string, depth: number): string | null {
  if (depth > 12) return `structure too deep to audit at ${path}`;
  if (value === null || value === undefined) return null;
  if (value instanceof PlatformSubject) return `platform identifiers at ${path}`;

  if (typeof value === "string") {
    if (EMAIL_LIKE.test(value)) return `an email-shaped value at ${path}`;
    if (DECLARED_NON_PII_FIELDS.has(leafName(path))) return null;
    if (PHONE_LIKE.test(value)) return `a phone-shaped value at ${path}`;
    if (BARE_SHA256.test(value)) return `an undeclared 64-hex value at ${path}`;
    return null;
  }
  if (typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const found = findIdentifier(v, `${path}[${i}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key) && typeof v === "string" && v !== REDACTED) {
      return `an unredacted value under sensitive key "${key}" at ${path}`;
    }
    const found = findIdentifier(v, `${path}.${key}`, depth + 1);
    if (found) return found;
  }
  return null;
}
