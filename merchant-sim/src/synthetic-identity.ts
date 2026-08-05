import { createHash } from "node:crypto";

/**
 * Deterministic synthetic buyers for the demo merchant.
 *
 * Every identity here is fabricated and unroutable by construction: `.invalid`
 * is reserved by RFC 2606 and can never resolve, and +44 7700 900xxx is the
 * range Ofcom reserves for drama, so no real handset can be reached. Nothing in
 * this project touches a real person's contact details at any stage, and the
 * ranges are chosen so that an accidental send fails rather than arrives.
 *
 * Buyers repeat across conversions on purpose. A returning purchaser is the
 * normal case in retail and it is what exercises deduplication — a suppression
 * pipeline that only ever sees unique buyers never proves it handles the
 * second purchase correctly.
 */

const BUYER_POOL = 64;

export interface SyntheticBuyer {
  /** Opaque merchant-scoped handle. This, not an identifier, is what travels
   * in a receipt commitment. */
  subjectRef: string;
  email: string;
  phone: string;
  consentGranted: boolean;
}

function seedOf(conversionId: string): number {
  const hash = createHash("sha256").update(`convertrail:synthetic-buyer:${conversionId}`).digest();
  return hash.readUInt32BE(0);
}

export function syntheticBuyer(conversionId: string): SyntheticBuyer {
  const index = seedOf(conversionId) % BUYER_POOL;
  return {
    subjectRef: `subj_${String(index).padStart(3, "0")}`,
    email: `buyer.${index}@synthetic.invalid`,
    phone: `+447700900${String(index).padStart(3, "0")}`,
    // A minority of buyers withhold consent for advertising suppression. The
    // pipeline must record that as a deliberate skip, not as a failure.
    consentGranted: index % 11 !== 0,
  };
}

/** Lowercased and trimmed, then SHA-256 — the normalisation ad platforms
 * specify for hashed email matching. */
export function normaliseEmail(email: string): string {
  return sha256Hex(email.trim().toLowerCase());
}

/**
 * Symbols and letters removed, leading zeros dropped, country code retained,
 * then SHA-256 — the rule Meta documents for the `ph` parameter. A number
 * normalised differently simply fails to match, silently and with no error, so
 * this is worth keeping in one place and testing.
 */
export function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length < 8) throw new Error("normalisePhone: implausibly short number");
  return sha256Hex(digits);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Platform-ready identifiers for a buyer. The only place raw synthetic
 * contact details are turned into what leaves the merchant. */
export function platformIdentifiers(buyer: SyntheticBuyer): Record<string, string> {
  return {
    em: normaliseEmail(buyer.email),
    ph: normalisePhone(buyer.phone),
    external_id: sha256Hex(`convertrail:external:${buyer.subjectRef}`),
  };
}
