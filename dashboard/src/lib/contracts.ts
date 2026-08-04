// Dashboard chain primitives — READ-ONLY. No private keys, no money-path
// hashing. The ABIs, reason/status enums, campaignId derivation, and fraud-log
// reconstruction below MIRROR `@convertrail/shared` for display only; they are
// duplicated (not imported) because the shared package is authored as raw .ts
// with explicit `.ts` import specifiers that the Next bundler will not resolve.
// The canonical money-path hashing (nullifier/evidenceHash) is NOT duplicated —
// the dashboard only reads emitted events, it never constructs claims.
import {
  createPublicClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  stringToBytes,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// --- Public Arc testnet config (all non-secret; mirrors .env.example) ---
export const CHAIN_ID = 5042002;
export const RPC_URL = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network";
export const EXPLORER_URL = process.env.ARC_EXPLORER_URL ?? "https://testnet.arcscan.app";
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as Address;

function deployedAddresses(): { agentRegistry: Address; conversionRegistry: Address; campaignEscrow: Address } {
  // Prefer the committed deployment record; fall back to the known addresses.
  const fallback = {
    agentRegistry: "0xB76d859523f14D8cf66304086c727EE08bc5d449" as Address,
    conversionRegistry: "0x0Df89eAAa1abae9AE01558B7149604857e29B4Ca" as Address,
    campaignEscrow: "0x1421cE35dD2Cb1Cc291eE1728B1AB091330acF2f" as Address,
  };
  try {
    const path = resolve(process.cwd(), "..", "contracts", "deployments", "arc-testnet.json");
    const json = JSON.parse(readFileSync(path, "utf8")) as { contracts: Record<string, Address> };
    return {
      agentRegistry: json.contracts.AgentRegistry ?? fallback.agentRegistry,
      conversionRegistry: json.contracts.ConversionRegistry ?? fallback.conversionRegistry,
      campaignEscrow: json.contracts.CampaignEscrow ?? fallback.campaignEscrow,
    };
  } catch {
    return fallback;
  }
}

export const ADDRESSES = deployedAddresses();

/** Which campaign to display: CAMPAIGN_NAME env, else campaign.name from
 * demo.config.json, else the reference run compiled in here for the case where
 * that file is not readable (a deployed build without the repo beside it). */
export function campaignName(): string {
  if (process.env.CAMPAIGN_NAME) return process.env.CAMPAIGN_NAME;
  try {
    const path = resolve(process.cwd(), "..", "demo.config.json");
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { campaign: { name: string } };
    return cfg.campaign.name;
  } catch {
    return "poc-demo-12";
  }
}

export function campaignIdFromName(name: string): Hex {
  return keccak256(stringToBytes(name));
}

// --- Resilient transport: the public Arc RPC throttles bursts with a
// nonstandard code (-32011 "request limit reached"); absorb it with backoff. ---
let rpcSchedule: Promise<void> = Promise.resolve();
let nextRpcAt = 0;
function paceRpc(): Promise<void> {
  const turn = rpcSchedule.then(async () => {
    const wait = Math.max(0, nextRpcAt - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    nextRpcAt = Date.now() + 200;
  });
  rpcSchedule = turn.catch(() => undefined);
  return turn;
}

function resilientHttp(url: string): Transport {
  const inner = http(url);
  return ((params: Parameters<Transport>[0]) => {
    const transport = inner(params);
    const request = async (args: unknown, options?: unknown): Promise<unknown> => {
      const MAX = 8;
      for (let attempt = 1; ; attempt++) {
        try {
          await paceRpc();
          return await (transport.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options);
        } catch (err) {
          const e = err as { details?: string; message?: string };
          const msg = `${e.details ?? ""} ${e.message ?? ""}`;
          if (!msg.includes("request limit") || attempt >= MAX) throw err;
          await new Promise((r) => setTimeout(r, 1_000 * attempt + Math.random() * 1_000));
        }
      }
    };
    return { ...transport, request };
  }) as Transport;
}

export const arcTestnet: Chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

let _client: PublicClient<Transport, Chain> | null = null;
export function publicClient(): PublicClient<Transport, Chain> {
  if (!_client) {
    _client = createPublicClient({ chain: arcTestnet, transport: resilientHttp(RPC_URL) });
  }
  return _client;
}

// --- Mirrored ABIs (display subset) ---
export const conversionRegistryAbi = parseAbi([
  "struct Claim { bytes32 campaignId; address publisher; bytes32 nullifier; bytes32 evidenceHash; uint64 submittedAtBlock; uint64 verdictAtBlock; uint8 status; uint8 reason; }",
  "function getClaim(uint256 claimId) external view returns (Claim memory)",
  "function claimCount() external view returns (uint256)",
  "function submitClaim(bytes32 campaignId, bytes32 nullifier, bytes32 evidenceHash) external returns (uint256)",
  "event ClaimSubmitted(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher, bytes32 nullifier, bytes32 evidenceHash)",
  "event ClaimVerified(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher)",
  "event ClaimRejected(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher, uint8 reason)",
  "event ClaimSettled(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher)",
  "event ClaimDisputed(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher)",
]);

export const campaignEscrowAbi = parseAbi([
  "struct Campaign { address advertiser; address operationalWallet; uint96 pricePerConversion; uint96 budget; uint96 recognizedTotal; uint96 reimbursedTotal; uint32 disputeWindowBlocks; bytes32 policyHash; }",
  "struct PublisherAllocation { uint96 cap; uint96 recognized; bool enrolled; }",
  "function getCampaign(bytes32 campaignId) external view returns (Campaign memory)",
  "function getAllocation(bytes32 campaignId, address publisher) external view returns (PublisherAllocation memory)",
  "event CampaignCreated(bytes32 indexed campaignId, address indexed advertiser, address operationalWallet, uint96 pricePerConversion, uint96 budget, uint32 disputeWindowBlocks, bytes32 policyHash)",
  "event PublisherEnrolled(bytes32 indexed campaignId, address indexed publisher, uint96 cap, uint256 gasProvision)",
  "event PayoutRecognized(bytes32 indexed campaignId, uint256 indexed claimId, address indexed publisher, uint96 amount)",
  "event BudgetReallocated(bytes32 indexed campaignId, address indexed fromPublisher, address indexed toPublisher, uint96 amount, bytes32 reasonCode, uint96 newFromCap, uint96 newToCap)",
  "event TruedUp(bytes32 indexed campaignId, address indexed operationalWallet, uint96 amount)",
]);

export const REJECT_REASON: Record<number, string> = {
  0: "NONE",
  1: "EVIDENCE_MISMATCH",
  2: "TIMING_ANOMALY",
  3: "RATE_ANOMALY",
  4: "MALFORMED_EVIDENCE",
  5: "LINKED_PUBLISHER",
};

export const CLAIM_STATUS: Record<number, string> = {
  0: "NONE",
  1: "PENDING",
  2: "VERIFIED",
  3: "REJECTED",
  4: "SETTLED",
  5: "DISPUTED",
};

export interface SubmittedEventArgs {
  claimId: bigint;
  campaignId: Hex;
  publisher: Address;
  nullifier: Hex;
  evidenceHash: Hex;
}
export interface RejectedEventArgs {
  claimId: bigint;
  campaignId: Hex;
  publisher: Address;
  reason: number;
}
export interface FraudLogEntry {
  claimId: bigint;
  campaignId: Hex;
  publisher: Address;
  nullifier: Hex;
  evidenceHash: Hex;
  reason: string;
}

/** Mirror of @convertrail/shared reconstructFraudLog — joins ClaimRejected to
 * its ClaimSubmitted to rebuild the evidence capsule purely from chain events. */
export function reconstructFraudLog(
  submitted: SubmittedEventArgs[],
  rejected: RejectedEventArgs[],
): FraudLogEntry[] {
  const byId = new Map<bigint, SubmittedEventArgs>();
  for (const event of submitted) byId.set(event.claimId, event);
  const entries: FraudLogEntry[] = [];
  for (const verdict of rejected) {
    const claim = byId.get(verdict.claimId);
    if (!claim) continue;
    entries.push({
      claimId: verdict.claimId,
      campaignId: claim.campaignId,
      publisher: claim.publisher,
      nullifier: claim.nullifier,
      evidenceHash: claim.evidenceHash,
      reason: REJECT_REASON[verdict.reason] ?? "NONE",
    });
  }
  entries.sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
  return entries;
}

export function txUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}
export function addressUrl(addr: string): string {
  return `${EXPLORER_URL}/address/${addr}`;
}
