import type { Hex } from "viem";

/**
 * Conversion event as emitted by the merchant source, plus its signature.
 * The evidence hash covers this entire object, signature included.
 */
export interface SignedConversionEvent {
  campaignId: Hex;
  conversionId: string;
  publisherId: string;
  clickTs: number;
  conversionTs: number;
  signature: Hex;
}
