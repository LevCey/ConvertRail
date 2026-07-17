// Publisher agent: consumes its conversion events from the merchant source,
// builds claims through the shared canonical library, submits on-chain.
// Usage: node agents/src/publisher.ts <publisherId>
import {
  campaignIdFromName,
  chainEnvFromProcess,
  conversionRegistryAbi,
  evidenceHash,
  loadDemoConfig,
  loadWallets,
  nullifier,
  publicClient,
  walletClient,
  type SignedConversionEvent,
} from "@convertrail/shared";

const publisherId = process.argv[2];
if (!publisherId) {
  console.error("usage: publisher.ts <publisherId>");
  process.exit(1);
}

const config = loadDemoConfig();
const wallets = loadWallets();
const entry = wallets[publisherId];
if (!entry) {
  console.error(`no wallet for ${publisherId}`);
  process.exit(1);
}

const env = chainEnvFromProcess();
const pub = publicClient(env);
const wallet = walletClient(env, entry.privateKey);
const campaignId = campaignIdFromName(config.campaign.name);
const merchantBase = `http://localhost:${config.merchantSim.port}`;

let sinceSeq = 0;
let submitted = 0;
console.log(`publisher ${publisherId} (${entry.address}) polling merchant-sim`);

setInterval(async () => {
  try {
    const res = await fetch(`${merchantBase}/events?publisherId=${publisherId}&sinceSeq=${sinceSeq}`);
    if (!res.ok) throw new Error(`merchant-sim ${res.status}`);
    const body = (await res.json()) as { events: { seq: number; event: SignedConversionEvent }[] };

    for (const { seq, event } of body.events) {
      sinceSeq = Math.max(sinceSeq, seq);
      const hash = await wallet.writeContract({
        address: env.conversionRegistry,
        abi: conversionRegistryAbi,
        functionName: "submitClaim",
        args: [campaignId, nullifier(campaignId, event.conversionId), evidenceHash(event)],
      });
      await pub.waitForTransactionReceipt({ hash });
      submitted++;
      console.log(`claim #${submitted} for ${event.conversionId} tx=${hash.slice(0, 14)}...`);
    }
  } catch (err) {
    console.error(`publisher ${publisherId} loop error:`, (err as Error).message.split("\n")[0]);
  }
}, 2_000);
