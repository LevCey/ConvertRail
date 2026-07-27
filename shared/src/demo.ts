import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { canonicalJSON } from "./canonical.ts";

export interface VerificationPolicy {
  minClickToConversionMs: number;
  maxClaimsPerWindow: number;
  rateWindowMs: number;
}

export interface DemoConfig {
  campaign: {
    name: string;
    pricePerConversion: string;
    budget: string;
    disputeWindowBlocks: number;
    gasProvisionEther: string;
    caps: Record<string, string>;
  };
  publishers: { id: string; eventIntervalMs: number }[];
  fraud: {
    id: string;
    attackIntervalMs: number;
    /** Synthetic traffic the fraud publisher drives: real events in the
     * merchant's records, but converting impossibly soon after the click —
     * the pattern the timing rule exists to catch. */
    botTraffic?: { eventIntervalMs: number; clickToConversionMs: number };
  };
  verification: VerificationPolicy;
  reallocation: {
    windowSize: number;
    rejectRateThreshold: number;
    minSamples: number;
    shiftFraction: number;
  };
  merchantSim: { port: number; seed: number; clickJitterMaxMs: number };
}

export interface WalletEntry {
  address: Address;
  privateKey: Hex;
}
export type DemoWallets = Record<string, WalletEntry>;

export function loadDemoConfig(): DemoConfig {
  return JSON.parse(readFileSync(resolve(process.cwd(), "demo.config.json"), "utf8"));
}

export function loadWallets(): DemoWallets {
  return JSON.parse(readFileSync(resolve(process.cwd(), ".wallets.json"), "utf8"));
}

export function campaignIdFromName(name: string): Hex {
  return keccak256(stringToBytes(name));
}

/** R6.4: the policy the referee applies is committed on-chain at campaign
 * creation; the verifier recomputes this hash from its own config and refuses
 * to start on mismatch. */
export function policyHash(policy: VerificationPolicy): Hex {
  return keccak256(stringToBytes(canonicalJSON(policy)));
}

/** Maps publisher ids from the demo config to their on-chain addresses. */
export function publisherBinding(wallets: DemoWallets, ids: string[]): Record<string, Address> {
  const binding: Record<string, Address> = {};
  for (const id of ids) {
    const entry = wallets[id];
    if (!entry) throw new Error(`no wallet for publisher id ${id}`);
    binding[id] = entry.address;
  }
  return binding;
}
