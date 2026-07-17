// Per-conversion payment rail. The interface is the seam the settlement
// loop is written against; the Nanopayments implementation is the locked
// primary path: sign an authorization with the operational key, then verify
// and settle directly against the Gateway facilitator — no HTTP 402 hop.
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import type { ChainEnv } from "@proof-of-conversion/shared";

export interface PaymentResult {
  ref: string; // Gateway settlement reference (UUID, not a chain tx hash)
  elapsedMs: number;
}

export interface SettlementRail {
  pay(to: Address, amountAtomic: bigint, memo: string): Promise<PaymentResult>;
}

export class NanopaymentsRail implements SettlementRail {
  private readonly scheme: BatchEvmScheme;
  private readonly facilitator: BatchFacilitatorClient;
  private readonly env: ChainEnv;

  constructor(operationalKey: Hex, env: ChainEnv) {
    this.scheme = new BatchEvmScheme(privateKeyToAccount(operationalKey));
    // The v3 SDK defaults to the mainnet API; the testnet URL must be
    // explicit or verification fails with unsupported_network.
    this.facilitator = new BatchFacilitatorClient({ url: env.gatewayApiUrl });
    this.env = env;
  }

  async pay(to: Address, amountAtomic: bigint, memo: string): Promise<PaymentResult> {
    const started = Date.now();
    const requirements = {
      scheme: "exact",
      network: `eip155:${this.env.chainId}`,
      asset: this.env.usdc,
      amount: amountAtomic.toString(),
      payTo: to,
      maxTimeoutSeconds: 3600,
      extra: {
        name: "GatewayWalletBatched",
        version: "1",
        verifyingContract: this.env.gatewayWallet,
      },
    };
    const base = await this.scheme.createPaymentPayload(2, requirements);
    // The transport layer normally adds resource + accepted; the Gateway
    // verify API requires both, so the direct path enriches manually.
    const payload = {
      ...base,
      resource: { url: `app://proof-of-conversion/${memo}`, description: memo, mimeType: "application/json" },
      accepted: requirements,
    };

    const verify = await this.facilitator.verify(payload as never, requirements as never);
    if (!verify.isValid) {
      throw new Error(`payment verify failed: ${verify.invalidReason}`);
    }
    const settle = await this.facilitator.settle(payload as never, requirements as never);
    if (!settle.success) {
      throw new Error(`payment settle failed: ${settle.errorReason}`);
    }
    return { ref: settle.transaction, elapsedMs: Date.now() - started };
  }
}
