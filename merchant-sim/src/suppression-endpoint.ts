import { createHash, timingSafeEqual } from "node:crypto";
import type { Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { ENVELOPE_VERSION, signEnvelope } from "../../suppression/src/envelope.ts";
import { SUPPRESSION_CONSENT_PURPOSE } from "../../suppression/src/types.ts";
import { platformIdentifiers, syntheticBuyer } from "./synthetic-identity.ts";

/**
 * Release of a buyer identity for one verified claim.
 *
 * Separated from the server so the authorisation path can be tested without
 * booting the simulator. This is the only place in the demo where anything
 * resembling personal data leaves the merchant, so it is worth being able to
 * assert directly that an unauthenticated caller gets nothing.
 */

export interface SubjectRecord {
  conversionId: string;
  conversionTs: number;
  /** What the buyer paid, in major units with an ISO currency. Omitted when the
   * merchant does not model an order value — never filled from the campaign's
   * affiliate commission, which is a publisher payout, not a purchase. */
  order?: { value: string; currency: string } | null | undefined;
  consentRecordedAt?: number | undefined;
}

export interface SuppressionEndpointConfig {
  token: string;
  ttlMs: number;
  now: () => number;
}

export interface EndpointResponse {
  status: number;
  body: unknown;
  /**
   * Applied by the caller to every response, including the refusals.
   *
   * `no-store` because a buyer's platform identifiers must not sit in a proxy
   * or a browser cache, and `Vary: Authorization` because the body genuinely
   * differs by credential — without it a shared cache could serve one caller's
   * envelope to an unauthenticated one.
   */
  headers: Record<string, string>;
}

export const PRIVACY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  vary: "Authorization",
};

/**
 * Digests are compared rather than raw bytes so that neither the comparison
 * time nor an early length check reveals anything about the configured token.
 */
export function tokenAccepted(configured: string, header: string | undefined): boolean {
  if (configured.length === 0) return false;
  const presented = createHash("sha256").update((header ?? "").replace(/^Bearer\s+/i, "")).digest();
  const expected = createHash("sha256").update(configured).digest();
  return timingSafeEqual(presented, expected);
}

export async function handleSuppressionSubject(
  evidenceHash: Hex,
  authorization: string | undefined,
  lookup: (hash: Hex) => SubjectRecord | undefined,
  merchant: LocalAccount,
  config: SuppressionEndpointConfig,
): Promise<EndpointResponse> {
  // An identity endpoint that falls open when a variable is missing is worse
  // than one that does not exist, so an unconfigured token refuses to serve.
  if (config.token.length === 0) {
    return {
      status: 503,
      body: { error: "suppression subject endpoint is not configured" },
      headers: PRIVACY_HEADERS,
    };
  }
  if (!tokenAccepted(config.token, authorization)) {
    return { status: 401, body: { error: "unauthorized" }, headers: PRIVACY_HEADERS };
  }

  const record = lookup(evidenceHash);
  if (!record) {
    return { status: 404, body: { error: "unknown evidence hash" }, headers: PRIVACY_HEADERS };
  }

  const buyer = syntheticBuyer(record.conversionId);
  try {
    const envelope = await buildEnvelope(evidenceHash, buyer, record, merchant, config);
    return { status: 200, body: envelope, headers: PRIVACY_HEADERS };
  } catch {
    // Returned rather than thrown so there is no path out of this function that
    // skips the privacy headers. A rejected promise handled by the server would
    // have produced a bare 500 — cacheable, and not varying on the credential.
    return {
      status: 500,
      body: { error: "could not build envelope" },
      headers: PRIVACY_HEADERS,
    };
  }
}

async function buildEnvelope(
  evidenceHash: Hex,
  buyer: ReturnType<typeof syntheticBuyer>,
  record: SubjectRecord,
  merchant: LocalAccount,
  config: SuppressionEndpointConfig,
): Promise<unknown> {
  return signEnvelope(
    {
      version: ENVELOPE_VERSION,
      evidenceHash,
      subjectRef: buyer.subjectRef,
      subject: platformIdentifiers(buyer),
      // The merchant's own record of when the purchase happened. The platform
      // needs the conversion's time, not the time suppression got round to it.
      occurredAt: new Date(record.conversionTs).toISOString(),
      // This simulator does not model a basket, so it states that rather than
      // inventing a figure. A real merchant substitutes the actual order total
      // in major units and its ISO currency.
      order: record.order ?? null,
      consent: {
        granted: buyer.consentGranted,
        purpose: SUPPRESSION_CONSENT_PURPOSE,
        recordedAt: new Date(record.consentRecordedAt ?? record.conversionTs).toISOString(),
      },
      // Short-lived so a leaked response stops being useful quickly, long
      // enough to survive a retry or two.
      expiresAt: new Date(config.now() + config.ttlMs).toISOString(),
    },
    merchant,
  );
}
