import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface ChainEnv {
  rpcUrl: string;
  chainId: number;
  usdc: Address;
  agentRegistry: Address;
  conversionRegistry: Address;
  campaignEscrow: Address;
  explorerUrl: string;
  gatewayApiUrl: string;
  gatewayWallet: Address;
}

export function chainEnvFromProcess(): ChainEnv {
  return {
    rpcUrl: required("ARC_TESTNET_RPC_URL"),
    chainId: Number(required("ARC_TESTNET_CHAIN_ID")),
    usdc: required("USDC_ADDRESS") as Address,
    agentRegistry: required("AGENT_REGISTRY_ADDRESS") as Address,
    conversionRegistry: required("CONVERSION_REGISTRY_ADDRESS") as Address,
    campaignEscrow: required("CAMPAIGN_ESCROW_ADDRESS") as Address,
    explorerUrl: required("ARC_EXPLORER_URL"),
    gatewayApiUrl: required("GATEWAY_API_URL"),
    gatewayWallet: required("GATEWAY_WALLET_ADDRESS") as Address,
  };
}

export function arcChain(env: ChainEnv): Chain {
  return defineChain({
    id: env.chainId,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [env.rpcUrl] } },
  });
}

/**
 * The public Arc testnet RPC throttles bursts with a nonstandard error code
 * (-32011 "request limit reached") that viem's built-in retry does not
 * recognize. This transport wraps `http` and absorbs those throttles with
 * jittered backoff so every client in the system is covered once, here.
 */
function resilientHttp(url: string): Transport {
  const inner = http(url);
  return ((params: Parameters<Transport>[0]) => {
    const transport = inner(params);
    const request = async (args: unknown, options?: unknown): Promise<unknown> => {
      const MAX = 8;
      for (let attempt = 1; ; attempt++) {
        try {
          return await (transport.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options);
        } catch (err) {
          const e = err as { details?: string; message?: string };
          const msg = `${e.details ?? ""} ${e.message ?? ""}`;
          if (!msg.includes("request limit") || attempt >= MAX) throw err;
          const delay = 1_000 * attempt + Math.random() * 1_000;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    };
    return { ...transport, request };
  }) as Transport;
}

export function publicClient(env: ChainEnv): PublicClient<Transport, Chain> {
  return createPublicClient({ chain: arcChain(env), transport: resilientHttp(env.rpcUrl) });
}

export function walletClient(
  env: ChainEnv,
  privateKey: Hex,
): WalletClient<Transport, Chain, Account> {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: arcChain(env),
    transport: resilientHttp(env.rpcUrl),
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env var ${name}`);
  return value;
}
