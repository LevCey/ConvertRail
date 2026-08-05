// Second, independent consumer of ClaimVerified. Submits the converted buyer to
// the advertiser's preconfigured acquisition exclusions and signs a receipt for
// what the platform actually accepted. Shares no state with settlement: a claim
// can fail every step here and still be paid, and a failed payment does not stop
// this from running.
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  campaignIdFromName,
  chainEnvFromProcess,
  conversionRegistryAbi,
  loadDemoConfig,
  publicClient,
} from "@convertrail/shared";
import { loadSuppressionConfig } from "./config.ts";
import { openEnvelope } from "./envelope.ts";
import { processClaim, type EnvelopeFetch, type RunnerDeps } from "./runner.ts";
import { SuppressionStore } from "./store.ts";
import { SuppressionWatcher, type ChainReader } from "./watcher.ts";
import { MockSuppressionAdapter } from "./adapters/mock.ts";
import { MetaSuppressionAdapter, metaConfigFromProcess } from "./adapters/meta.ts";
import type { SuppressionAdapter } from "./adapters/types.ts";
import type { VerifiedClaim } from "./types.ts";

const config = loadDemoConfig();
const env = chainEnvFromProcess();
const pub = publicClient(env);
const campaignId = campaignIdFromName(config.campaign.name);

// Validated before anything is constructed and before a single request goes
// out. A misconfiguration discovered on the first claim becomes a signed FAILED
// receipt — a durable record of an operator mistake dressed up as an outcome.
const runtime = loadSuppressionConfig(process.env, { merchantPort: config.merchantSim.port });
const { policy, merchantBaseUrl, serviceToken, merchantAddress } = runtime;
const platform = policy.platform;

function buildAdapter(): SuppressionAdapter {
  if (platform === "meta") return new MetaSuppressionAdapter(metaConfigFromProcess());
  return new MockSuppressionAdapter();
}

/**
 * Retrieve the buyer identity for one claim.
 *
 * The response is authenticated against the merchant address before it is
 * trusted: the merchant is the source of the identity, so a compromised or
 * confused one is exactly the case worth defending against. Transport problems
 * are retryable; a refusal or an unopenable envelope is not, because repeating
 * the request cannot change either.
 */
async function fetchEnvelope(claim: VerifiedClaim): Promise<EnvelopeFetch> {
  let response: Response;
  try {
    response = await fetch(`${merchantBaseUrl}/suppression-subject/${claim.evidenceHash}`, {
      headers: { authorization: `Bearer ${serviceToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { ok: false, retryable: true, reason: `ENVELOPE_TRANSPORT:${(error as Error).name}` };
  }
  if (response.status === 429 || response.status >= 500) {
    return { ok: false, retryable: true, reason: `ENVELOPE_HTTP_${response.status}` };
  }
  if (!response.ok) return { ok: false, retryable: false, reason: `ENVELOPE_HTTP_${response.status}` };

  const opened = await openEnvelope(await response.json(), {
    merchant: merchantAddress,
    evidenceHash: claim.evidenceHash,
    nowMs: Date.now(),
  });
  if (!opened.ok) return { ok: false, retryable: false, reason: `ENVELOPE_REJECTED:${opened.reason}` };
  return { ok: true, envelope: opened.envelope };
}

const store = new SuppressionStore();
const deps: RunnerDeps = {
  store,
  adapter: buildAdapter(),
  policy,
  signer: privateKeyToAccount(runtime.signerKey),
  tenantId: config.campaign.name,
  commitmentKey: runtime.commitmentKey || "disabled-placeholder-key-not-for-production",
  fetchEnvelope,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const reader: ChainReader = {
  currentBlock: () => pub.getBlockNumber(),
  verifiedIn: (from, to) => readClaimEvents("ClaimVerified", from, to),
  disputedIn: (from, to) => readClaimEvents("ClaimDisputed", from, to),
  claimEvidence: async (claimId) => {
    const claim = await pub.readContract({
      address: env.conversionRegistry,
      abi: conversionRegistryAbi,
      functionName: "getClaim",
      args: [BigInt(claimId)],
    });
    if (claim.campaignId !== campaignId) return null;
    return { campaignId: claim.campaignId, evidenceHash: claim.evidenceHash };
  },
};

async function readClaimEvents(
  eventName: "ClaimVerified" | "ClaimDisputed",
  from: bigint,
  to: bigint,
): Promise<Array<{ claimId: string; blockNumber: bigint }>> {
  const logs = await pub.getContractEvents({
    address: env.conversionRegistry,
    abi: conversionRegistryAbi,
    eventName,
    fromBlock: from,
    toBlock: to,
  });
  return logs
    .filter((log) => (log.args as { campaignId?: Hex }).campaignId === campaignId)
    .map((log) => ({
      claimId: String((log.args as { claimId: bigint }).claimId),
      blockNumber: log.blockNumber,
    }));
}

const watcher = new SuppressionWatcher({
  store,
  reader,
  campaignId,
  platform,
  maxInFlight: runtime.maxInFlight,
  maxPending: runtime.maxPending,
  process: async (claim) => {
    const receipt = await processClaim(claim, deps);
    console.log(
      `claim ${claim.claimId} suppression ${receipt.status} ` +
        `(${receipt.receiptId}, ${receipt.platform}/${receipt.executionMode})`,
    );
  },
  onError: (error, context) => console.error(`suppression failed for ${context}: ${error.message}`),
});

const startBlock = await watcher.start();
const recovered = watcher.resume();

console.log(
  `suppression watcher on ${campaignId.slice(0, 10)}... platform=${platform} ` +
    `enabled=${policy.enabled} dryRun=${policy.dryRun} from block ${startBlock}` +
    (recovered > 0 ? ` (${recovered} unfinished claims recovered)` : ""),
);

setInterval(() => {
  void watcher
    .poll()
    .catch((error: Error) => console.error(`suppression poll failed: ${error.message}`));
}, 2000);
