// A payment signer backed by a Circle developer-controlled wallet.
//
// Nanopayments only needs `{address, signTypedData}` from whoever holds the
// operational funds, so the wallet's key can live with Circle instead of in a
// local file. Arc is not one of Circle's managed chains, so the wallet is
// created on the virtual EVM-TESTNET chain: Circle signs, we broadcast. It
// must be an EOA — Gateway verifies EIP-3009 by plain ECDSA recovery against
// `from`, which a smart-contract account's signature would not satisfy.
import type { Address, Hex } from "viem";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

interface TypedDataParams {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface CircleSignerConfig {
  apiKey: string;
  entitySecret: string;
  walletId: string;
  address: Address;
}

export class CircleWalletSigner {
  readonly address: Address;
  private readonly sdk: ReturnType<typeof initiateDeveloperControlledWalletsClient>;
  private readonly walletId: string;

  constructor(config: CircleSignerConfig) {
    this.address = config.address;
    this.walletId = config.walletId;
    this.sdk = initiateDeveloperControlledWalletsClient({
      apiKey: config.apiKey,
      entitySecret: config.entitySecret,
    });
  }

  /** Reads the signer's configuration from the environment, or returns null
   * when it is not configured — the caller then falls back to a local key. */
  static fromEnv(): CircleSignerConfig | null {
    const apiKey = process.env.CIRCLE_API_KEY;
    const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
    const walletId = process.env.CIRCLE_WALLET_ID;
    const address = process.env.CIRCLE_WALLET_ADDRESS as Address | undefined;
    if (!walletId) return null;
    if (!apiKey || !entitySecret || !address) {
      throw new Error(
        "CIRCLE_WALLET_ID is set, so CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET and " +
          "CIRCLE_WALLET_ADDRESS are all required. Unset CIRCLE_WALLET_ID to use a local key.",
      );
    }
    return { apiKey, entitySecret, walletId, address };
  }

  async signTypedData(params: TypedDataParams): Promise<Hex> {
    // Circle wants the EIP-712 payload as a JSON string, with the domain type
    // declared — viem omits EIP712Domain from `types`, so add it back. The
    // authorization's numeric fields arrive as BigInt, which JSON cannot
    // serialize; EIP-712 numbers travel as decimal strings anyway.
    const data = JSON.stringify(
      {
        domain: params.domain,
        primaryType: params.primaryType,
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          ...params.types,
        },
        message: params.message,
      },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    );

    try {
      const response = await this.sdk.signTypedData({ walletId: this.walletId, data });
      const signature = response.data?.signature;
      if (!signature) throw new Error("Circle returned no signature");
      return signature as Hex;
    } catch (err) {
      const detail = (err as { response?: { data?: unknown } })?.response?.data;
      throw new Error(
        `Circle signTypedData failed: ${detail ? JSON.stringify(detail) : (err as Error).message}`,
      );
    }
  }
}
