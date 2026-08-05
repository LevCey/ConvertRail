import { createHash } from "node:crypto";
import { canonicalJSON } from "@convertrail/shared";
import type { ExclusionCoverage, SuppressionPlatform } from "../types.ts";
import type {
  AdapterOutcome,
  AudienceMutationInput,
  AudienceMutationResult,
  ConversionDispatchInput,
  ConversionDispatchResult,
  ExclusionVerificationInput,
  ExclusionVerificationResult,
  FailureClass,
  SuppressionAdapter,
} from "./types.ts";

/**
 * Meta implementation of the three suppression capabilities.
 *
 * Contract verified against the official documentation on 2026-08-04; the
 * points that remain unconfirmed are handled by refusing to assume success
 * rather than by guessing. Nothing here has been run against a live ad account.
 *
 * The version is pinned rather than tracking `latest`. A Graph API release that
 * silently changed our request shape would change what a signed receipt attests
 * to, which is the one thing this module cannot allow to drift.
 */

export interface MetaConfig {
  apiVersion: string;
  accessToken: string;
  pixelId: string;
  audienceId: string;
  adAccountId: string;
  /**
   * The acquisition ad sets that must exclude the suppression audience.
   *
   * Declared explicitly, never discovered. A check that scans whatever the
   * account happens to contain has no denominator: it can report full coverage
   * across three inactive ad sets while the campaign actually spending money is
   * outside the page it read. The operator states what must be true; the check
   * only confirms it.
   */
  acquisitionAdSetIds: string[];
  /** Meta's own test mode. Events arrive in the Test Events view and are not
   * used for optimisation or reporting. */
  testEventCode?: string | undefined;
  baseUrl: string;
  timeoutMs: number;
}

const DEFAULT_API_VERSION = "v25.0";

export function metaConfigFromProcess(): MetaConfig {
  return {
    apiVersion: process.env.META_GRAPH_API_VERSION ?? DEFAULT_API_VERSION,
    accessToken: process.env.META_ACCESS_TOKEN ?? "",
    pixelId: process.env.META_PIXEL_ID ?? "",
    audienceId: process.env.META_SUPPRESSION_AUDIENCE_ID ?? "",
    adAccountId: process.env.META_AD_ACCOUNT_ID ?? "",
    acquisitionAdSetIds: (process.env.META_ACQUISITION_AD_SET_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
    testEventCode: process.env.META_TEST_EVENT_CODE || undefined,
    baseUrl: process.env.META_GRAPH_BASE_URL ?? "https://graph.facebook.com",
    timeoutMs: Number(process.env.META_TIMEOUT_MS ?? 15_000),
  };
}

/** Documented as wait-and-retry: throttling and transient platform downtime. */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 368]);
/** Credential and permission problems. Repeating the request cannot fix any
 * of them, and retrying a rejected token is how an app gets blocked. */
const AUTH_CODES = new Set([10, 102, 190]);

export class MetaSuppressionAdapter implements SuppressionAdapter {
  readonly platform: SuppressionPlatform = "meta";
  readonly #config: MetaConfig;

  constructor(config: MetaConfig) {
    this.#config = config;
  }

  /**
   * Server-side Purchase event.
   *
   * `event_id` is the caller's deterministic id, re-sent verbatim on every
   * retry. That is the only reason a retry after an unknown result is safe:
   * Meta deduplicates on it, so the second request collapses into the first
   * instead of booking a second purchase.
   */
  async sendConversion(input: ConversionDispatchInput): Promise<ConversionDispatchResult> {
    const event: Record<string, unknown> = {
      event_name: "Purchase",
      event_time: input.occurredAtUnix,
      event_id: input.eventId,
      action_source: "website",
      user_data: input.subject.forPlatform(),
    };
    // Omitted entirely when the merchant does not model an order value. The
    // alternative — substituting the campaign's affiliate commission, which is
    // atomic USDC — would write a fabricated sale figure into the advertiser's
    // own reporting and into any value-based optimisation built on it.
    if (input.order) {
      event.custom_data = { currency: input.order.currency, value: input.order.value };
    }

    const body: Record<string, unknown> = {
      data: [event],
      access_token: this.#config.accessToken,
    };
    if (this.#config.testEventCode) body.test_event_code = this.#config.testEventCode;

    // Reports the request that would have gone out, so a dry run is auditable
    // rather than merely quiet: the deduplication id, the merchant's conversion
    // time, and whether an order value was present at all.
    if (input.dryRun) {
      return this.#dryRun("conversion", {
        eventId: input.eventId,
        occurredAtUnix: input.occurredAtUnix,
        hasOrder: input.order !== null,
        currency: input.order?.currency ?? "none",
      });
    }

    const response = await this.#post(`${this.#config.pixelId}/events`, body);
    if (response.failure) return response.failure;

    // Acceptance, never delivery. Meta has taken the event; whether it matches
    // a person, and whether that changes any ad, happens later and out of view.
    const received = numeric(response.json?.events_received);
    if (received === undefined) {
      return {
        kind: "unknown",
        detail: { reason: "no events_received in response" },
        failure: { class: "unknown", code: "META_AMBIGUOUS_RESPONSE", retryable: true },
      };
    }
    return {
      kind: received > 0 ? "accepted" : "rejected",
      platformRef: asString(response.json?.fbtrace_id),
      detail: { eventsReceived: received },
      failure:
        received > 0
          ? undefined
          : { class: "validation", code: "META_NO_EVENTS_RECEIVED", retryable: false },
    };
  }

  /**
   * Add the buyer to the preconfigured exclusion audience.
   *
   * The edge has no idempotency key, and does not need one: audience membership
   * is a set, so adding the same person twice yields one member. That is a
   * different guarantee from the conversion edge's `event_id` deduplication and
   * the two must not be conflated — this one is safe to repeat, that one is only
   * safe to repeat with the identical id.
   */
  async addToExclusionAudience(input: AudienceMutationInput): Promise<AudienceMutationResult> {
    const identifiers = input.subject.forPlatform();
    const schema: string[] = [];
    const row: string[] = [];
    if (identifiers.em) {
      schema.push("EMAIL_SHA256");
      row.push(identifiers.em);
    }
    if (identifiers.ph) {
      schema.push("PHONE_SHA256");
      row.push(identifiers.ph);
    }
    if (schema.length === 0) {
      return {
        kind: "rejected",
        detail: { reason: "no supported identifier kinds" },
        failure: { class: "validation", code: "META_NO_USABLE_IDENTIFIER", retryable: false },
      };
    }

    const body = {
      payload: {
        schema,
        data: [row],
        is_raw: false,
        session: {
          // Derived from the idempotency key so a retry reuses the same session
          // rather than opening a new one Meta would wait to see completed.
          session_id: sessionId(input.idempotencyKey),
          batch_seq: 1,
          last_batch_flag: true,
          estimated_num_total: 1,
        },
      },
      access_token: this.#config.accessToken,
    };

    if (input.dryRun) return this.#dryRun("audience", { identifiers: schema.length });

    // `test_event_code` scopes conversions to Meta's Test Events view, but the
    // audience edge has no equivalent — this write would be entirely real. That
    // combination produces the worst of both: a receipt whose conversion never
    // counted, against an audience change that did. Refused rather than
    // half-executed.
    if (this.#config.testEventCode) {
      return {
        kind: "rejected",
        detail: { reason: "test event code configured alongside a live audience write" },
        failure: { class: "validation", code: "META_TEST_MODE_LIVE_AUDIENCE", retryable: false },
      };
    }

    const response = await this.#post(`${this.#config.audienceId}/users`, body);
    if (response.failure) return response.failure;

    const received = numeric(response.json?.num_received);
    const invalid = numeric(response.json?.num_invalid_entries) ?? 0;
    if (received === undefined) {
      return {
        kind: "unknown",
        detail: { reason: "no num_received in response" },
        failure: { class: "unknown", code: "META_AMBIGUOUS_RESPONSE", retryable: true },
      };
    }
    if (received === 0 || invalid > 0) {
      return {
        kind: "rejected",
        platformRef: asString(response.json?.session_id),
        detail: { numReceived: received, numInvalidEntries: invalid },
        failure: { class: "validation", code: "META_ENTRY_INVALID", retryable: false },
      };
    }
    return {
      kind: "accepted",
      platformRef: asString(response.json?.session_id),
      detail: { numReceived: received, numInvalidEntries: invalid },
    };
  }

  /**
   * Read-only. Counts how many of the account's active ad sets exclude the
   * suppression audience.
   *
   * Coverage is reported as a fraction rather than a boolean because partial
   * coverage is the realistic state — one campaign created last week without
   * the exclusion is exactly the thing an advertiser needs told, and a boolean
   * would either hide it or overstate it.
   *
   * This adapter never writes targeting. Adding an exclusion on the
   * advertiser's behalf would change ad delivery, which is their decision and
   * outside what a receipt can honestly attest to.
   */
  async verifyExclusionConfiguration(
    input: ExclusionVerificationInput,
  ): Promise<ExclusionVerificationResult> {
    const targets = this.#config.acquisitionAdSetIds;

    // A dry run reads nothing. There is no simulated answer worth giving here:
    // the whole value of this check is that it observed the advertiser's live
    // configuration, and a dry run did not. It reports the target scope it
    // would have inspected, with every one of them unresolved, so the receipt
    // lands on PARTIAL rather than claiming an exclusion nobody confirmed.
    if (input.dryRun) {
      return {
        kind: "processed",
        platformRef: "dryrun_exclusion",
        detail: { targeted: targets.length, observed: 0, excluding: 0, dryRun: true },
        coverage: {
          targeted: targets.length,
          observed: 0,
          excluding: 0,
          unresolved: [...targets].sort(),
        },
      };
    }
    // No declared scope means no denominator. A check with nothing to check
    // must fail loudly rather than return a vacuously perfect 0/0.
    if (targets.length === 0) {
      return {
        kind: "rejected",
        detail: { reason: "no acquisition ad sets configured" },
        failure: { class: "validation", code: "META_NO_EXCLUSION_TARGETS", retryable: false },
      };
    }

    const account = this.#config.adAccountId.startsWith("act_")
      ? this.#config.adAccountId
      : `act_${this.#config.adAccountId}`;
    const params = new URLSearchParams({
      fields: "id,targeting{excluded_custom_audiences}",
      limit: String(Math.max(200, targets.length)),
      // Ask only about the declared targets. Reading the whole account would
      // both scan data we have no need for and invite the denominator to drift.
      filtering: JSON.stringify([{ field: "id", operator: "IN", value: targets }]),
      access_token: this.#config.accessToken,
    });

    const response = await this.#get(`${account}/adsets`, params);
    if (response.failure) return response.failure;

    const adSets = Array.isArray(response.json?.data) ? (response.json.data as unknown[]) : undefined;
    if (!adSets) {
      return {
        kind: "unknown",
        detail: { reason: "no ad set list in response" },
        failure: { class: "unknown", code: "META_AMBIGUOUS_RESPONSE", retryable: true },
      };
    }

    const wanted = String(this.#config.audienceId);
    const observed = new Map<string, boolean>();
    for (const entry of adSets) {
      const record = entry as { id?: unknown; targeting?: { excluded_custom_audiences?: unknown } };
      const id = String(record.id ?? "");
      // Anything outside the declared scope is discarded rather than counted.
      // A stray ad set that happens to exclude the audience must not be able to
      // inflate coverage over the ones we actually asked about.
      if (id.length === 0 || !targets.includes(id)) continue;
      observed.set(id, excludesAudience(record.targeting?.excluded_custom_audiences, wanted));
    }

    const unresolved = targets.filter((id) => !observed.has(id)).sort();
    const coverage: ExclusionCoverage = {
      targeted: targets.length,
      observed: observed.size,
      excluding: [...observed.values()].filter(Boolean).length,
      unresolved,
    };

    return {
      kind: "processed",
      detail: {
        targeted: coverage.targeted,
        observed: coverage.observed,
        excluding: coverage.excluding,
        unresolved: unresolved.length,
      },
      coverage,
      // Over the sorted per-ad-set observation, not the ratio. Two different
      // configurations can produce the same ratio, and a receipt committing
      // only to "2 of 3" could never be checked back against what was seen.
      configurationDigest: createHash("sha256")
        .update(
          canonicalJSON({
            api: this.#config.apiVersion,
            audience: wanted,
            adSets: [...observed.entries()]
              .map(([id, excludes]) => ({ id, excludes }))
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
            unresolved,
          }),
        )
        .digest("hex"),
    };
  }

  #dryRun(action: string, detail: Record<string, string | number | boolean>): AdapterOutcome {
    return {
      kind: "accepted",
      platformRef: `dryrun_${action}`,
      detail: { ...detail, dryRun: true },
    };
  }

  #url(path: string): string {
    return `${this.#config.baseUrl}/${this.#config.apiVersion}/${path}`;
  }

  async #post(path: string, body: unknown): Promise<GraphResponse> {
    return this.#request(this.#url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async #get(path: string, params: URLSearchParams): Promise<GraphResponse> {
    return this.#request(`${this.#url(path)}?${params.toString()}`, { method: "GET" });
  }

  async #request(url: string, init: RequestInit): Promise<GraphResponse> {
    if (this.#config.accessToken.length === 0) {
      return {
        failure: {
          kind: "rejected",
          detail: { reason: "no access token configured" },
          failure: { class: "authorisation", code: "META_NO_TOKEN", retryable: false },
        },
      };
    }

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.#config.timeoutMs) });
    } catch (error) {
      // A request that never returned may still have been executed. It is
      // reported as unknown, never as failure, so the retry re-sends the same
      // idempotency key rather than treating the effect as absent.
      return {
        failure: {
          kind: "unknown",
          detail: { reason: (error as Error).name },
          failure: { class: "transport", code: "META_NO_RESPONSE", retryable: true },
        },
      };
    }

    let json: Record<string, unknown> | undefined;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      json = undefined;
    }

    if (response.ok && json) return { json };
    return { failure: classify(response.status, json) };
  }
}

interface GraphResponse {
  json?: Record<string, unknown>;
  failure?: AdapterOutcome;
}

/**
 * Map a Graph API error onto our retry semantics.
 *
 * Anything unrecognised is treated as permanent. The alternative — retrying by
 * default — turns an unfamiliar rejection into repeated calls against an
 * advertiser's account, which is the worse failure for a system whose job is to
 * be trustworthy with someone else's ad platform credentials.
 */
export function classify(status: number, json: Record<string, unknown> | undefined): AdapterOutcome {
  const error = (json?.error ?? {}) as Record<string, unknown>;
  const code = numeric(error.code);
  const subcode = numeric(error.error_subcode);
  const trace = asString(error.fbtrace_id);

  let failureClass: FailureClass = "validation";
  let retryable = false;

  if (code !== undefined && AUTH_CODES.has(code)) {
    failureClass = "authorisation";
  } else if (code !== undefined && RETRYABLE_CODES.has(code)) {
    failureClass = code === 4 || code === 17 || code === 341 ? "throttle" : "transient";
    retryable = true;
  } else if (code !== undefined && code >= 200 && code <= 299) {
    failureClass = "authorisation";
  } else if (status === 429) {
    failureClass = "throttle";
    retryable = true;
  } else if (status >= 500) {
    failureClass = "transient";
    retryable = true;
  }

  return {
    // A throttled or temporarily unavailable request may or may not have been
    // executed; only a definite rejection is recorded as one.
    kind: retryable ? "unknown" : "rejected",
    platformRef: trace,
    detail: { status, code: code ?? -1, subcode: subcode ?? -1 },
    failure: {
      class: failureClass,
      code: `META_${status}_${code ?? "NONE"}`,
      retryable,
    },
  };
}

/** Both documented shapes: an array of ids, or of objects carrying `id`. */
function excludesAudience(excluded: unknown, audienceId: string): boolean {
  if (!Array.isArray(excluded)) return false;
  return excluded.some((entry) =>
    typeof entry === "object" && entry !== null
      ? String((entry as { id?: unknown }).id) === audienceId
      : String(entry) === audienceId,
  );
}

/** Stable positive integer under 2^31, which is what the session field takes. */
export function sessionId(idempotencyKey: string): number {
  return createHash("sha256").update(idempotencyKey).digest().readUInt32BE(0) % 2_147_483_647;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}
