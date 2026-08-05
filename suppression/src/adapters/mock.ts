import { keccak256, stringToHex } from "viem";
import type { ExclusionCoverage, SuppressionPlatform } from "../types.ts";
import type {
  AdapterOutcome,
  AudienceMutationInput,
  AudienceMutationResult,
  ConversionDispatchInput,
  ConversionDispatchResult,
  ExclusionVerificationInput,
  ExclusionVerificationResult,
  SuppressionAdapter,
} from "./types.ts";

export type ScriptStep =
  | "accepted"
  | "processed"
  | "transient"
  | "throttle"
  | "permanent"
  | "unauthorised"
  | "unknown";

export interface MockScript {
  conversion?: ScriptStep[] | undefined;
  audience?: ScriptStep[] | undefined;
  exclusion?: ScriptStep[] | undefined;
  /** Defaults to a complete two-ad-set scope, so the happy path exercises the
   * completeness rule rather than bypassing it. */
  coverage?: ExclusionCoverage | undefined;
}

export interface MockCall {
  action: "conversion" | "audience" | "exclusion-check";
  idempotencyKey: string;
  eventId?: string | undefined;
  occurredAtUnix?: number | undefined;
  order?: { value: string; currency: string } | null | undefined;
  subjectKinds?: string[] | undefined;
  dryRun: boolean;
}

/**
 * Deterministic, scriptable stand-in for a real platform.
 *
 * Two behaviours matter more than the happy path. It replays platform-side
 * idempotency: a repeated key after an accepted call returns the original
 * reference instead of acting twice, so a test can prove that our retry logic
 * does not double-write. And it can return `unknown`, the outcome that actually
 * breaks naive integrations — a request that may or may not have landed.
 */
export class MockSuppressionAdapter implements SuppressionAdapter {
  readonly platform: SuppressionPlatform = "mock";
  readonly calls: MockCall[] = [];

  /** Stated outright rather than derived with `Required<…>`: that helper strips
   * optionality but keeps an explicit `| undefined`, which is exactly the case
   * the resolved script must not have. */
  readonly #script: {
    conversion: ScriptStep[];
    audience: ScriptStep[];
    exclusion: ScriptStep[];
    coverage: ExclusionCoverage;
  };
  readonly #cursor = new Map<string, number>();
  readonly #settled = new Map<string, AdapterOutcome>();

  constructor(script: MockScript = {}) {
    this.#script = {
      conversion: script.conversion ?? ["accepted"],
      audience: script.audience ?? ["accepted"],
      exclusion: script.exclusion ?? ["processed"],
      coverage: script.coverage ?? { targeted: 2, observed: 2, excluding: 2, unresolved: [] },
    };
  }

  async sendConversion(input: ConversionDispatchInput): Promise<ConversionDispatchResult> {
    this.calls.push({
      action: "conversion",
      idempotencyKey: input.idempotencyKey,
      eventId: input.eventId,
      occurredAtUnix: input.occurredAtUnix,
      order: input.order,
      subjectKinds: input.subject.presentKinds(),
      dryRun: input.dryRun,
    });
    return this.#resolve("conversion", input.idempotencyKey, input.dryRun, {
      eventId: input.eventId,
      occurredAtUnix: input.occurredAtUnix,
      hasOrder: input.order !== null,
    });
  }

  async addToExclusionAudience(input: AudienceMutationInput): Promise<AudienceMutationResult> {
    this.calls.push({
      action: "audience",
      idempotencyKey: input.idempotencyKey,
      subjectKinds: input.subject.presentKinds(),
      dryRun: input.dryRun,
    });
    return this.#resolve("audience", input.idempotencyKey, input.dryRun, {
      identifiers: input.subject.presentKinds().length,
    });
  }

  async verifyExclusionConfiguration(
    input: ExclusionVerificationInput,
  ): Promise<ExclusionVerificationResult> {
    this.calls.push({
      action: "exclusion-check",
      idempotencyKey: input.idempotencyKey,
      dryRun: input.dryRun,
    });
    const base = await this.#resolve("exclusion", input.idempotencyKey, input.dryRun, {});
    if (base.kind === "rejected" || base.kind === "unknown") return base;
    const { coverage } = this.#script;
    return {
      ...base,
      coverage,
      configurationDigest: keccak256(
        stringToHex(
          `mock:exclusion:${coverage.targeted}:${coverage.observed}:${coverage.excluding}:${coverage.unresolved.join("|")}`,
        ),
      ),
    };
  }

  /** Number of distinct external effects, ignoring idempotent repeats. */
  effectCount(action: MockCall["action"]): number {
    return new Set(
      this.calls.filter((c) => c.action === action).map((c) => c.idempotencyKey),
    ).size;
  }

  async #resolve(
    track: "conversion" | "audience" | "exclusion",
    key: string,
    dryRun: boolean,
    detail: Record<string, string | number | boolean>,
  ): Promise<AdapterOutcome> {
    const settled = this.#settled.get(key);
    if (settled) return { ...settled, detail: { ...settled.detail, deduplicated: true } };

    const steps = this.#script[track];
    const index = this.#cursor.get(key) ?? 0;
    this.#cursor.set(key, index + 1);
    const step = steps[Math.min(index, steps.length - 1)] ?? "accepted";

    const ref = `mock_${keccak256(stringToHex(`${track}:${key}`)).slice(2, 18)}`;
    const outcome = buildOutcome(step, ref, { ...detail, dryRun });
    if (outcome.kind === "accepted" || outcome.kind === "processed" || outcome.kind === "rejected") {
      this.#settled.set(key, outcome);
    }
    return outcome;
  }
}

function buildOutcome(
  step: ScriptStep,
  ref: string,
  detail: Record<string, string | number | boolean>,
): AdapterOutcome {
  switch (step) {
    case "accepted":
      return { kind: "accepted", platformRef: ref, detail };
    case "processed":
      return { kind: "processed", platformRef: ref, detail };
    case "transient":
      return {
        kind: "unknown",
        detail,
        failure: { class: "transient", code: "MOCK_TRANSIENT", retryable: true },
      };
    case "throttle":
      return {
        kind: "unknown",
        detail,
        failure: { class: "throttle", code: "MOCK_THROTTLED", retryable: true },
      };
    case "permanent":
      return {
        kind: "rejected",
        detail,
        failure: { class: "validation", code: "MOCK_INVALID", retryable: false },
      };
    case "unauthorised":
      return {
        kind: "rejected",
        detail,
        failure: { class: "authorisation", code: "MOCK_FORBIDDEN", retryable: false },
      };
    case "unknown":
      return {
        kind: "unknown",
        detail,
        failure: { class: "transport", code: "MOCK_NO_RESPONSE", retryable: true },
      };
  }
}
