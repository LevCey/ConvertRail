import { isAddress } from "viem";
import type { Hex } from "viem";
import type { SuppressionPlatform, SuppressionPolicy } from "./types.ts";

/**
 * Startup validation for the suppression watcher.
 *
 * Pure and testable on purpose. Every value here is one an operator can get
 * wrong, and the alternative to checking at startup is discovering it as a
 * first-claim failure — an empty service token became a 401 and a signed FAILED
 * receipt, which is a durable record of a configuration mistake dressed up as
 * an outcome.
 *
 * All problems are collected and reported together. Fixing one misconfiguration
 * per restart is its own kind of failure when a deployment has several.
 */

export interface SuppressionRuntimeConfig {
  policy: SuppressionPolicy;
  commitmentKey: string;
  signerKey: Hex;
  serviceToken: string;
  merchantAddress: Hex;
  merchantBaseUrl: string;
  maxInFlight: number;
  maxPending: number;
}

export class SuppressionConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`suppression configuration is not usable:\n  - ${problems.join("\n  - ")}`);
    this.name = "SuppressionConfigError";
    this.problems = problems;
  }
}

const IMPLEMENTED_PLATFORMS = new Set<SuppressionPlatform>(["mock", "meta"]);

/**
 * Positive, finite, integral. A bound read as `NaN` from a typo silently
 * disables itself — `attempts >= NaN` is false forever, so a claim would retry
 * until the iteration ceiling instead of its budget.
 */
function positiveInteger(
  problems: string[],
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    problems.push(`${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return value;
}

export function loadSuppressionConfig(
  env: Record<string, string | undefined>,
  defaults: { merchantPort: number },
): SuppressionRuntimeConfig {
  const problems: string[] = [];

  const platform = (env.SUPPRESSION_PLATFORM ?? "mock") as SuppressionPlatform;
  if (!IMPLEMENTED_PLATFORMS.has(platform)) {
    problems.push(
      `SUPPRESSION_PLATFORM=${JSON.stringify(platform)} has no implementation in this version`,
    );
  }

  const enabled = env.SUPPRESSION_ENABLED === "true";
  // Defaults to a dry run, and only the literal "false" turns it off, so a
  // half-configured environment cannot send anything to an ad account.
  const dryRun = env.SUPPRESSION_DRY_RUN !== "false";

  const policy: SuppressionPolicy = {
    platform,
    trigger: "VERIFIED",
    enabled,
    dryRun,
    maxAttempts: positiveInteger(problems, "SUPPRESSION_MAX_ATTEMPTS", env.SUPPRESSION_MAX_ATTEMPTS, 5),
    slaSeconds: positiveInteger(problems, "SUPPRESSION_SLA_SECONDS", env.SUPPRESSION_SLA_SECONDS, 300),
  };
  const maxInFlight = positiveInteger(problems, "SUPPRESSION_MAX_IN_FLIGHT", env.SUPPRESSION_MAX_IN_FLIGHT, 4);
  const maxPending = positiveInteger(problems, "SUPPRESSION_MAX_PENDING", env.SUPPRESSION_MAX_PENDING, 256);
  if (maxPending < maxInFlight) {
    problems.push(
      `SUPPRESSION_MAX_PENDING (${maxPending}) is below SUPPRESSION_MAX_IN_FLIGHT (${maxInFlight})`,
    );
  }

  const commitmentKey = env.SUPPRESSION_COMMITMENT_KEY ?? "";
  const signerKey = env.SUPPRESSION_SIGNER_KEY ?? "";
  const serviceToken = env.SUPPRESSION_SERVICE_TOKEN ?? "";
  const merchantAddress = env.MERCHANT_ADDRESS ?? "";

  if (enabled) {
    if (commitmentKey.length < 32) {
      problems.push("SUPPRESSION_COMMITMENT_KEY must be at least 32 characters");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(signerKey)) {
      problems.push("SUPPRESSION_SIGNER_KEY must be a 32-byte hex private key");
    }
    // Checked here rather than left to the first claim: without it the merchant
    // refuses every request, and the run records a signed FAILED receipt for a
    // buyer it never even asked about.
    if (serviceToken.length === 0) {
      problems.push("SUPPRESSION_SERVICE_TOKEN is required to fetch suppression envelopes");
    }
    if (!isAddress(merchantAddress)) {
      problems.push("MERCHANT_ADDRESS must be a valid address to authenticate envelopes");
    }
  }

  // Meta credentials are needed only when something will actually be sent. A
  // true dry run reaches no network at all, so demanding a live token for one
  // would be a check with nothing behind it.
  if (enabled && platform === "meta" && !dryRun) {
    for (const [name, value] of [
      ["META_ACCESS_TOKEN", env.META_ACCESS_TOKEN],
      ["META_PIXEL_ID", env.META_PIXEL_ID],
      ["META_SUPPRESSION_AUDIENCE_ID", env.META_SUPPRESSION_AUDIENCE_ID],
      ["META_AD_ACCOUNT_ID", env.META_AD_ACCOUNT_ID],
    ] as const) {
      if (!value || value.length === 0) problems.push(`${name} is required for a live Meta run`);
    }
    const targets = (env.META_ACQUISITION_AD_SET_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (targets.length === 0) {
      problems.push(
        "META_ACQUISITION_AD_SET_IDS must list the acquisition ad sets required to exclude the " +
          "suppression audience; without it an exclusion check has no denominator",
      );
    }
    if (env.META_TEST_EVENT_CODE) {
      problems.push(
        "META_TEST_EVENT_CODE cannot be set for a live run: conversions would be scoped to Test " +
          "Events while the audience write would be real",
      );
    }
  }

  if (problems.length > 0) throw new SuppressionConfigError(problems);

  return {
    policy,
    commitmentKey,
    // Never used to sign anything when suppression is disabled: the watcher
    // records intents and signs SKIPPED receipts, and this placeholder exists
    // only so the process can start for inspection.
    signerKey: (signerKey || `0x${"00".repeat(31)}01`) as Hex,
    serviceToken,
    merchantAddress: merchantAddress as Hex,
    merchantBaseUrl: env.MERCHANT_SIM_URL ?? `http://127.0.0.1:${defaults.merchantPort}`,
    maxInFlight,
    maxPending,
  };
}
