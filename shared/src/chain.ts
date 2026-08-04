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
import { nonceManager, privateKeyToAccount } from "viem/accounts";

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
 * The public Arc testnet RPC throttles bursts with nonstandard errors that
 * viem's built-in retry does not recognize. It has more than one: -32011
 * "request limit reached" for burst rate, and "Request exceeds defined limit"
 * for the sustained budget. Matching only the first left the second falling
 * through as a hard failure, which is how a throttle turned into a stalled
 * run. Match on markers, not on one message.
 */
// Four distinct messages observed from this endpoint so far: -32011 "request
// limit reached", "Request exceeds defined limit", -32005 "rate limit exceeded",
// and standard 429s. Each was found the hard way, which is the argument for
// matching a family of markers rather than any single string.
const THROTTLE_MARKERS = [
  "request limit",
  "exceeds defined limit",
  "rate limit",
  "too many requests",
  "429",
];

function isThrottle(message: string): boolean {
  const m = message.toLowerCase();
  return THROTTLE_MARKERS.some((marker) => m.includes(marker));
}

/**
 * Throttle accounting, exported so a component can report how much of its wall
 * clock went to backoff rather than to work. Without this, time lost to retries
 * is invisible and gets misattributed to whichever call happened to be holding
 * it — which is how a profiler lies.
 */
export const transportStats = {
  retries: 0,
  /** Summed across calls, so it may exceed wall-clock time when requests
   * overlap. Report it as cumulative backoff, never as a share of the run. */
  backoffMs: 0,
  exhausted: 0,
  byMethod: {} as Record<string, { requests: number; retries: number; backoffMs: number }>,
};

function methodStat(method: string) {
  return (transportStats.byMethod[method] ??= { requests: 0, retries: 0, backoffMs: 0 });
}

function resilientHttp(url: string): Transport {
  const inner = http(url);
  return ((params: Parameters<Transport>[0]) => {
    const transport = inner(params);
    const request = async (args: unknown, options?: unknown): Promise<unknown> => {
      const MAX = 8;
      const method = (args as { method?: string })?.method ?? "unknown";
      const stat = methodStat(method);
      stat.requests++;
      for (let attempt = 1; ; attempt++) {
        try {
          return await (transport.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options);
        } catch (err) {
          const e = err as { details?: string; message?: string };
          const msg = `${e.details ?? ""} ${e.message ?? ""}`;
          if (!isThrottle(msg)) throw err;
          if (attempt >= MAX) {
            transportStats.exhausted++;
            throw err;
          }
          const delay = 1_000 * attempt + Math.random() * 1_000;
          transportStats.retries++;
          transportStats.backoffMs += delay;
          stat.retries++;
          stat.backoffMs += delay;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    };
    return { ...transport, request };
  }) as Transport;
}

// Polling interval is left at viem's default deliberately. Arc blocks every
// ~0.5 s, so a shorter interval looks like free latency — but this system is
// bound by the public RPC's request budget, not by poll frequency. Measured
// across three runs: 4 s default gave a median claim-to-verdict lag of 152
// blocks, 2 s gave 343 on the same workload, because the extra polling bought
// throttling and stalled loops rather than speed.

export function publicClient(env: ChainEnv): PublicClient<Transport, Chain> {
  return createPublicClient({ chain: arcChain(env), transport: resilientHttp(env.rpcUrl) });
}

/**
 * Accounts carry viem's nonce manager. Sequential awaited sends never needed it,
 * but the verifier now keeps several verdict transactions in flight, and two
 * sends that overlap a nonce fetch would otherwise be assigned the same nonce
 * and one would be silently dropped. Managing nonces locally makes the
 * assignment monotonic regardless of overlap.
 */
export function walletClient(
  env: ChainEnv,
  privateKey: Hex,
): WalletClient<Transport, Chain, Account> {
  return createWalletClient({
    account: privateKeyToAccount(privateKey, { nonceManager }),
    chain: arcChain(env),
    transport: resilientHttp(env.rpcUrl),
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env var ${name}`);
  return value;
}
