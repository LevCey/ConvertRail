import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SuppressionConfigError, loadSuppressionConfig } from "./config.ts";

/**
 * Every value here is one an operator can get wrong. The alternative to
 * checking at startup is discovering it as a first-claim failure, which writes a
 * signed FAILED receipt — a durable record of a configuration mistake that reads
 * like an outcome.
 */

const DEFAULTS = { merchantPort: 4600 };
const KEY = "c".repeat(48);
const SIGNER = `0x${"42".repeat(32)}`;
const MERCHANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function enabledEnv(extra: Record<string, string | undefined> = {}) {
  return {
    SUPPRESSION_ENABLED: "true",
    SUPPRESSION_PLATFORM: "mock",
    SUPPRESSION_COMMITMENT_KEY: KEY,
    SUPPRESSION_SIGNER_KEY: SIGNER,
    SUPPRESSION_SERVICE_TOKEN: "t".repeat(40),
    MERCHANT_ADDRESS: MERCHANT,
    ...extra,
  };
}

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadSuppressionConfig(env, DEFAULTS);
    return [];
  } catch (error) {
    assert.equal(error instanceof SuppressionConfigError, true);
    return (error as SuppressionConfigError).problems;
  }
}

test("a disabled watcher starts without credentials", () => {
  const config = loadSuppressionConfig({}, DEFAULTS);
  assert.equal(config.policy.enabled, false);
  assert.equal(config.policy.dryRun, true, "dry run is the default");
  assert.equal(config.policy.platform, "mock");
});

test("only the literal \"false\" leaves dry-run mode", () => {
  assert.equal(loadSuppressionConfig({ SUPPRESSION_DRY_RUN: "0" }, DEFAULTS).policy.dryRun, true);
  assert.equal(loadSuppressionConfig({ SUPPRESSION_DRY_RUN: "no" }, DEFAULTS).policy.dryRun, true);
  assert.equal(loadSuppressionConfig({ SUPPRESSION_DRY_RUN: "false" }, DEFAULTS).policy.dryRun, false);
});

test("a fully configured enabled watcher validates", () => {
  const config = loadSuppressionConfig(enabledEnv(), DEFAULTS);
  assert.equal(config.policy.enabled, true);
  assert.equal(config.serviceToken.length, 40);
  assert.equal(config.merchantAddress, MERCHANT);
});

test("an empty service token stops startup rather than becoming a first-claim 401", () => {
  const problems = problemsOf(enabledEnv({ SUPPRESSION_SERVICE_TOKEN: "" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /SUPPRESSION_SERVICE_TOKEN is required/);
});

test("a missing or malformed merchant address is refused", () => {
  for (const value of ["", "not-an-address", "0x1234"]) {
    const problems = problemsOf(enabledEnv({ MERCHANT_ADDRESS: value }));
    assert.match(problems.join(" "), /MERCHANT_ADDRESS must be a valid address/);
  }
});

test("a short commitment key or malformed signer key is refused", () => {
  assert.match(
    problemsOf(enabledEnv({ SUPPRESSION_COMMITMENT_KEY: "short" })).join(" "),
    /at least 32 characters/,
  );
  for (const value of ["", "0xdead", "42".repeat(32)]) {
    assert.match(
      problemsOf(enabledEnv({ SUPPRESSION_SIGNER_KEY: value })).join(" "),
      /32-byte hex private key/,
    );
  }
});

test("every problem is reported at once rather than one per restart", () => {
  const problems = problemsOf({
    SUPPRESSION_ENABLED: "true",
    SUPPRESSION_PLATFORM: "mock",
  });
  assert.equal(problems.length, 4, problems.join(" | "));
});

test("bounds must be positive whole numbers", () => {
  for (const name of [
    "SUPPRESSION_MAX_ATTEMPTS",
    "SUPPRESSION_SLA_SECONDS",
    "SUPPRESSION_MAX_IN_FLIGHT",
    "SUPPRESSION_MAX_PENDING",
  ]) {
    for (const value of ["0", "-1", "2.5", "abc", "Infinity", "NaN"]) {
      const problems = problemsOf(enabledEnv({ [name]: value }));
      assert.match(
        problems.join(" "),
        new RegExp(`${name} must be a positive whole number`),
        `${name}=${value} must be refused`,
      );
    }
  }
});

test("a NaN bound cannot silently disable the budget it is meant to enforce", () => {
  // `attempts >= NaN` is false forever, so an unchecked value would let a claim
  // retry to the iteration ceiling instead of its budget.
  assert.match(
    problemsOf(enabledEnv({ SUPPRESSION_MAX_ATTEMPTS: "five" })).join(" "),
    /positive whole number/,
  );
});

test("bounds accept sensible values and fall back when unset", () => {
  const config = loadSuppressionConfig(
    enabledEnv({ SUPPRESSION_MAX_ATTEMPTS: "3", SUPPRESSION_MAX_IN_FLIGHT: "8", SUPPRESSION_MAX_PENDING: "64" }),
    DEFAULTS,
  );
  assert.equal(config.policy.maxAttempts, 3);
  assert.equal(config.maxInFlight, 8);
  assert.equal(config.maxPending, 64);

  const defaults = loadSuppressionConfig(enabledEnv(), DEFAULTS);
  assert.equal(defaults.policy.maxAttempts, 5);
  assert.equal(defaults.maxInFlight, 4);
  assert.equal(defaults.maxPending, 256);
});

test("a pending bound below the in-flight width is refused as incoherent", () => {
  assert.match(
    problemsOf(enabledEnv({ SUPPRESSION_MAX_IN_FLIGHT: "8", SUPPRESSION_MAX_PENDING: "4" })).join(" "),
    /below SUPPRESSION_MAX_IN_FLIGHT/,
  );
});

test("an unimplemented platform is refused at startup", () => {
  for (const platform of ["google", "tiktok", "linkedin"]) {
    assert.match(
      problemsOf(enabledEnv({ SUPPRESSION_PLATFORM: platform })).join(" "),
      /has no implementation in this version/,
    );
  }
});

test("a live Meta run requires every Meta object id and a token", () => {
  const problems = problemsOf(
    enabledEnv({ SUPPRESSION_PLATFORM: "meta", SUPPRESSION_DRY_RUN: "false" }),
  );
  for (const name of [
    "META_ACCESS_TOKEN",
    "META_PIXEL_ID",
    "META_SUPPRESSION_AUDIENCE_ID",
    "META_AD_ACCOUNT_ID",
    "META_ACQUISITION_AD_SET_IDS",
  ]) {
    assert.match(problems.join(" "), new RegExp(name), `${name} must be required`);
  }
});

test("a live Meta run refuses a test event code", () => {
  const problems = problemsOf(
    enabledEnv({
      SUPPRESSION_PLATFORM: "meta",
      SUPPRESSION_DRY_RUN: "false",
      META_ACCESS_TOKEN: "token",
      META_PIXEL_ID: "1",
      META_SUPPRESSION_AUDIENCE_ID: "2",
      META_AD_ACCOUNT_ID: "act_3",
      META_ACQUISITION_AD_SET_IDS: "100,200",
      META_TEST_EVENT_CODE: "TEST1234",
    }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /META_TEST_EVENT_CODE cannot be set for a live run/);
});

test("a live Meta run with everything present validates", () => {
  const config = loadSuppressionConfig(
    enabledEnv({
      SUPPRESSION_PLATFORM: "meta",
      SUPPRESSION_DRY_RUN: "false",
      META_ACCESS_TOKEN: "token",
      META_PIXEL_ID: "1",
      META_SUPPRESSION_AUDIENCE_ID: "2",
      META_AD_ACCOUNT_ID: "act_3",
      META_ACQUISITION_AD_SET_IDS: "100, 200",
    }),
    DEFAULTS,
  );
  assert.equal(config.policy.platform, "meta");
  assert.equal(config.policy.dryRun, false);
});

test("a Meta dry run needs no live credentials, since it reaches no network", () => {
  const config = loadSuppressionConfig(
    enabledEnv({ SUPPRESSION_PLATFORM: "meta", SUPPRESSION_DRY_RUN: "true" }),
    DEFAULTS,
  );
  assert.equal(config.policy.platform, "meta");
  assert.equal(config.policy.dryRun, true);
});

test("an empty acquisition ad set list is refused for a live run", () => {
  const problems = problemsOf(
    enabledEnv({
      SUPPRESSION_PLATFORM: "meta",
      SUPPRESSION_DRY_RUN: "false",
      META_ACCESS_TOKEN: "token",
      META_PIXEL_ID: "1",
      META_SUPPRESSION_AUDIENCE_ID: "2",
      META_AD_ACCOUNT_ID: "act_3",
      META_ACQUISITION_AD_SET_IDS: " , , ",
    }),
  );
  assert.match(problems.join(" "), /no denominator/);
});

test("the merchant base url falls back to the configured simulator port", () => {
  assert.equal(loadSuppressionConfig({}, DEFAULTS).merchantBaseUrl, "http://127.0.0.1:4600");
  assert.equal(
    loadSuppressionConfig({ MERCHANT_SIM_URL: "https://merchant.example.invalid" }, DEFAULTS)
      .merchantBaseUrl,
    "https://merchant.example.invalid",
  );
});

test("the error names every problem so a deployment is fixed in one pass", () => {
  try {
    loadSuppressionConfig({ SUPPRESSION_ENABLED: "true" }, DEFAULTS);
    assert.fail("must throw");
  } catch (error) {
    assert.equal((error as Error).name, "SuppressionConfigError");
    assert.match((error as Error).message, /SUPPRESSION_COMMITMENT_KEY/);
    assert.match((error as Error).message, /SUPPRESSION_SERVICE_TOKEN/);
    assert.match((error as Error).message, /MERCHANT_ADDRESS/);
  }
});
