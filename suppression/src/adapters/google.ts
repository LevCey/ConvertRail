import type { SuppressionPlatform } from "../types.ts";
import {
  NotImplementedAdapterError,
  type AudienceMutationInput,
  type AudienceMutationResult,
  type ConversionDispatchInput,
  type ConversionDispatchResult,
  type ExclusionVerificationInput,
  type ExclusionVerificationResult,
  type SuppressionAdapter,
} from "./types.ts";

/**
 * Interface-only. Present so the shape of the seam is settled by more than one
 * platform, and so nothing in the core is quietly written around Meta's model.
 *
 * Google's equivalents are enhanced conversions for the dispatch, a Customer
 * Match user list for the audience, and negative audience targeting on the
 * campaign for the check. The mapping is close enough to reuse this interface
 * but the membership and matching semantics differ, and none of it is verified
 * here — implementing this requires reading the current API documentation
 * first, not extrapolating from Meta.
 */
export class GoogleSuppressionAdapter implements SuppressionAdapter {
  readonly platform: SuppressionPlatform = "google";

  async sendConversion(_input: ConversionDispatchInput): Promise<ConversionDispatchResult> {
    throw new NotImplementedAdapterError(this.platform);
  }

  async addToExclusionAudience(_input: AudienceMutationInput): Promise<AudienceMutationResult> {
    throw new NotImplementedAdapterError(this.platform);
  }

  async verifyExclusionConfiguration(
    _input: ExclusionVerificationInput,
  ): Promise<ExclusionVerificationResult> {
    throw new NotImplementedAdapterError(this.platform);
  }
}
