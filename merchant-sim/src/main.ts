// Simulated conversion source: emits signed conversion events at configured
// per-publisher rates. Demo stand-in for an advertiser's postback system —
// the trust problem it represents is solved on the roadmap (zkTLS), not here.
import { createServer } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import {
  campaignIdFromName,
  canonicalJSON,
  evidenceHash,
  loadDemoConfig,
  loadWallets,
  type SignedConversionEvent,
} from "@proof-of-conversion/shared";

const config = loadDemoConfig();
const wallets = loadWallets();
const merchant = privateKeyToAccount(wallets.merchant.privateKey);
const campaignId = campaignIdFromName(config.campaign.name);

// Deterministic jitter so demo takes are reproducible (mulberry32).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(config.merchantSim.seed);

interface StoredEvent {
  seq: number;
  event: SignedConversionEvent;
  hash: `0x${string}`;
}

const events: StoredEvent[] = [];
const byHash = new Map<string, SignedConversionEvent>();
let seq = 0;
let conversionCounter = 0;

async function emitEvent(publisherId: string): Promise<void> {
  const now = Date.now();
  const clickDelta =
    config.verification.minClickToConversionMs + Math.floor(rand() * config.merchantSim.clickJitterMaxMs);
  const body = {
    campaignId,
    conversionId: `c-${++conversionCounter}`,
    publisherId,
    clickTs: now - clickDelta,
    conversionTs: now,
  };
  const signature = await merchant.signMessage({ message: canonicalJSON(body) });
  const event: SignedConversionEvent = { ...body, signature };
  const hash = evidenceHash(event);
  const stored = { seq: ++seq, event, hash };
  events.push(stored);
  byHash.set(hash, event);
  console.log(`event ${body.conversionId} for ${publisherId} (${hash.slice(0, 10)}...)`);
}

for (const publisher of config.publishers) {
  setInterval(() => void emitEvent(publisher.id), publisher.eventIntervalMs);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.setHeader("Content-Type", "application/json");

  if (url.pathname === "/events") {
    const publisherId = url.searchParams.get("publisherId");
    const sinceSeq = Number(url.searchParams.get("sinceSeq") ?? 0);
    const matched = events.filter(
      (e) => e.seq > sinceSeq && (!publisherId || e.event.publisherId === publisherId),
    );
    res.end(JSON.stringify({ events: matched }));
    return;
  }

  const byHashMatch = url.pathname.match(/^\/event-by-hash\/(0x[0-9a-fA-F]{64})$/);
  if (byHashMatch) {
    const event = byHash.get(byHashMatch[1]);
    if (!event) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "unknown evidence hash" }));
      return;
    }
    res.end(JSON.stringify({ event }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(config.merchantSim.port, () => {
  console.log(`merchant-sim listening on :${config.merchantSim.port} (campaign ${campaignId.slice(0, 10)}...)`);
});
