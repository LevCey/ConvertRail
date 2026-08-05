import { canonicalJSON } from "@convertrail/shared";
import { getAddress, isAddressEqual, recoverMessageAddress, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import {
  PlatformSubject,
  SUPPRESSION_CONSENT_PURPOSE,
  type OrderValue,
  type SuppressionEnvelope,
} from "./types.ts";

/** Merchant and watcher clocks are not synchronised. A few seconds of skew is
 * ordinary; a timestamp minutes ahead of us is not, and is refused. */
const CLOCK_TOLERANCE_MS = 60_000;

export const ENVELOPE_VERSION = "convertrail.suppression.envelope/1";

/**
 * Domain separator, distinct from the receipt's and from the conversion
 * event's.
 *
 * The merchant key signs conversion events as bare `canonicalJSON(body)`. If an
 * envelope were signed the same way, a body that parses as both would let one
 * signature stand for the other — the merchant would have authorised an
 * identity release by signing a conversion. The prefix makes the two preimages
 * disjoint by construction.
 */
const SIGNING_PREFIX = "ConvertRail Suppression Envelope v1";

/** Identifier kinds a merchant may release. Anything else is refused rather
 * than forwarded to a platform we have not reasoned about. */
const ALLOWED_SUBJECT_KINDS = new Set(["em", "ph", "external_id"]);

export interface EnvelopeBody {
  version: string;
  evidenceHash: Hex;
  subjectRef: string;
  /** Already normalised and hashed by the merchant. Personal data. */
  subject: Record<string, string>;
  /** The merchant's own record of when the purchase happened. */
  occurredAt: string;
  order: OrderValue | null;
  consent: { granted: boolean; purpose: string; recordedAt: string };
  expiresAt: string;
}

/** Rejected outright rather than passed through: a value in atomic units or a
 * chain token symbol reaching an ad platform's purchase field would corrupt the
 * advertiser's own reporting. */
const ISO_CURRENCY = /^[A-Z]{3}$/;
const DECIMAL_AMOUNT = /^(0|[1-9]\d{0,12})(\.\d{1,2})?$/;

export interface EnvelopeWire extends EnvelopeBody {
  merchantSignature: Hex;
}

export function envelopePreimage(body: EnvelopeBody): string {
  return `${SIGNING_PREFIX}\n${canonicalJSON(body)}`;
}

export async function signEnvelope(
  body: EnvelopeBody,
  account: LocalAccount,
): Promise<EnvelopeWire> {
  const merchantSignature = await account.signMessage({ message: envelopePreimage(body) });
  return { ...body, merchantSignature };
}

export type OpenResult =
  | { ok: true; envelope: SuppressionEnvelope }
  | { ok: false; reason: string };

export interface OpenOptions {
  merchant: Address;
  evidenceHash: Hex;
  nowMs: number;
}

/**
 * Parse and authenticate an envelope received over the network.
 *
 * Everything here treats the response as untrusted, including the merchant's:
 * the merchant is the source of the identity, so a compromised or confused one
 * is exactly the case worth defending against. The binding that matters is
 * evidence hash to subject — without it, a merchant response could attach any
 * buyer to any verified claim, and the receipt would attest to the wrong person.
 *
 * Consent is deliberately not enforced here. A withheld-consent envelope is
 * valid and must reach the core, which records a `SKIPPED` receipt; rejecting it
 * as malformed would lose the distinction between "we chose not to" and
 * "something broke".
 */
export async function openEnvelope(wire: unknown, options: OpenOptions): Promise<OpenResult> {
  if (typeof wire !== "object" || wire === null) return { ok: false, reason: "envelope is not an object" };
  const w = wire as Record<string, unknown>;

  if (w.version !== ENVELOPE_VERSION) return { ok: false, reason: "unsupported envelope version" };
  if (typeof w.evidenceHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(w.evidenceHash)) {
    return { ok: false, reason: "malformed evidence hash" };
  }
  if (w.evidenceHash.toLowerCase() !== options.evidenceHash.toLowerCase()) {
    return { ok: false, reason: "envelope is bound to a different claim" };
  }
  if (typeof w.subjectRef !== "string" || w.subjectRef.length === 0) {
    return { ok: false, reason: "missing subject reference" };
  }
  if (typeof w.expiresAt !== "string" || Number.isNaN(Date.parse(w.expiresAt))) {
    return { ok: false, reason: "malformed expiry" };
  }
  if (Date.parse(w.expiresAt) <= options.nowMs) return { ok: false, reason: "envelope has expired" };

  if (typeof w.occurredAt !== "string" || Number.isNaN(Date.parse(w.occurredAt))) {
    return { ok: false, reason: "malformed conversion timestamp" };
  }
  if (Date.parse(w.occurredAt) > options.nowMs + CLOCK_TOLERANCE_MS) {
    return { ok: false, reason: "conversion timestamp is in the future" };
  }

  const order = w.order;
  if (order !== null) {
    if (typeof order !== "object" || Array.isArray(order)) {
      return { ok: false, reason: "malformed order value" };
    }
    const { value, currency } = order as Record<string, unknown>;
    // A merchant that cannot express the purchase in major units and a real ISO
    // currency is better off omitting it. Passing a wrong figure through would
    // land in the advertiser's own reporting as a real sale.
    if (typeof value !== "string" || !DECIMAL_AMOUNT.test(value)) {
      return { ok: false, reason: "order value is not a decimal amount in major units" };
    }
    if (typeof currency !== "string" || !ISO_CURRENCY.test(currency)) {
      return { ok: false, reason: "order currency is not an ISO 4217 code" };
    }
  }

  const consent = w.consent as Record<string, unknown> | undefined;
  if (
    typeof consent !== "object" ||
    consent === null ||
    typeof consent.granted !== "boolean" ||
    typeof consent.purpose !== "string" ||
    typeof consent.recordedAt !== "string"
  ) {
    return { ok: false, reason: "malformed consent record" };
  }
  // Consent for a different purpose is not consent for this one. Accepting any
  // non-empty string here would let a merchant's newsletter opt-in authorise
  // sending a buyer's identifiers to an ad platform.
  if (consent.purpose !== SUPPRESSION_CONSENT_PURPOSE) {
    return { ok: false, reason: "consent was not recorded for advertising suppression" };
  }
  if (Number.isNaN(Date.parse(consent.recordedAt))) {
    return { ok: false, reason: "malformed consent timestamp" };
  }
  if (Date.parse(consent.recordedAt) > options.nowMs + CLOCK_TOLERANCE_MS) {
    return { ok: false, reason: "consent timestamp is in the future" };
  }

  if (typeof w.subject !== "object" || w.subject === null || Array.isArray(w.subject)) {
    return { ok: false, reason: "malformed subject" };
  }
  const subject = w.subject as Record<string, unknown>;
  const kinds = Object.keys(subject);
  if (kinds.length === 0) return { ok: false, reason: "subject carries no identifier" };
  for (const kind of kinds) {
    if (!ALLOWED_SUBJECT_KINDS.has(kind)) return { ok: false, reason: `unsupported identifier kind ${kind}` };
    const value = subject[kind];
    // Refuse anything that is not already a hash: a raw address arriving here
    // means the merchant skipped normalisation, and forwarding it would put
    // plaintext personal data on the wire to an ad platform.
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
      return { ok: false, reason: `identifier ${kind} is not a normalised hash` };
    }
  }

  if (typeof w.merchantSignature !== "string" || !/^0x[0-9a-fA-F]+$/.test(w.merchantSignature)) {
    return { ok: false, reason: "malformed merchant signature" };
  }

  const { merchantSignature, ...body } = w;
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: envelopePreimage(body as unknown as EnvelopeBody),
      signature: merchantSignature as Hex,
    });
  } catch {
    return { ok: false, reason: "merchant signature is not recoverable" };
  }
  if (!isAddressEqual(recovered, getAddress(options.merchant))) {
    return { ok: false, reason: "envelope was not signed by the expected merchant" };
  }

  return {
    ok: true,
    envelope: {
      version: ENVELOPE_VERSION,
      evidenceHash: w.evidenceHash as Hex,
      subjectRef: w.subjectRef,
      subject: new PlatformSubject(subject as Record<string, string>),
      occurredAt: w.occurredAt,
      order: (order as OrderValue | null) ?? null,
      consent: {
        granted: consent.granted as boolean,
        purpose: consent.purpose as string,
        recordedAt: consent.recordedAt as string,
      },
      expiresAt: w.expiresAt,
      merchantSignature: merchantSignature as Hex,
    },
  };
}
