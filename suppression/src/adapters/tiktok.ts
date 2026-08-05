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
 * Interface-only, for the same reason as the Google adapter.
 *
 * TikTok's equivalents are an Events API purchase, a partner audience for the
 * membership, and audience exclusion on the ad group for the check. Unverified;
 * do not implement from this comment.
 */
export class TikTokSuppressionAdapter implements SuppressionAdapter {
  readonly platform: SuppressionPlatform = "tiktok";

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
