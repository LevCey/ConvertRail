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
} from "@convertrail/shared";
import { PRIVACY_HEADERS, handleSuppressionSubject } from "./suppression-endpoint.ts";

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

async function emitEvent(publisherId: string, fixedClickDeltaMs?: number): Promise<void> {
  const now = Date.now();
  const clickDelta =
    fixedClickDeltaMs ??
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

// The fraud publisher drives traffic too, and it lands in the merchant's
// records like anyone else's — it is simply synthetic, converting far too
// soon after the click for a human to have been involved.
const bot = config.fraud.botTraffic;
if (bot) {
  setInterval(() => void emitEvent(config.fraud.id, bot.clickToConversionMs), bot.eventIntervalMs);
}

// The fraud agent's second identity produces entirely ordinary traffic: real
// signed events with human click-to-conversion delays. Nothing about these
// conversions is wrong, which is the point — the defect is who is claiming
// them, not what happened.
const sybil = config.fraud.sybil;
if (sybil) {
  setInterval(() => void emitEvent(sybil.id), sybil.eventIntervalMs);
}

// Buyer identities are released only to a caller holding this token, and only
// one claim at a time. Absent configuration the endpoint refuses to serve at
// all: an identity endpoint that falls open when a variable is missing is worse
// than one that does not exist.
const suppressionToken = process.env.SUPPRESSION_SERVICE_TOKEN ?? "";
const ENVELOPE_TTL_MS = 5 * 60_000;

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

  // Identifies which campaign this process is emitting for. A harness can
  // then tell its own merchant source apart from someone else's holding the
  // port — otherwise agents happily claim a foreign campaign's conversions
  // and every claim is refused for evidence that never belonged to it.
  if (url.pathname === "/health") {
    res.end(JSON.stringify({ campaignId, campaignName: config.campaign.name, events: events.length }));
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

  // Buyer identity for one verified claim, keyed by the same evidence hash the
  // chain already commits to. Deliberately not part of /events: the publisher
  // feed is read by every agent in the demo, and an identity that appears there
  // is an identity everyone has.
  const subjectMatch = url.pathname.match(/^\/suppression-subject\/(0x[0-9a-fA-F]{64})$/);
  if (subjectMatch) {
    const hash = subjectMatch[1] as `0x${string}`;
    // Set before the handler is entered, so no outcome — including a rejected
    // promise — can produce a response that a cache is free to store or to
    // serve to a caller presenting different credentials.
    for (const [name, value] of Object.entries(PRIVACY_HEADERS)) res.setHeader(name, value);
    void handleSuppressionSubject(
      hash,
      req.headers.authorization,
      (h) => {
        const event = byHash.get(h);
        return event && { conversionId: event.conversionId, conversionTs: event.conversionTs };
      },
      merchant,
      { token: suppressionToken, ttlMs: ENVELOPE_TTL_MS, now: Date.now },
    ).then(
      ({ status, body, headers }) => {
        res.statusCode = status;
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        res.end(JSON.stringify(body));
      },
      () => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "could not build envelope" }));
      },
    );
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `merchant-sim cannot start: port ${config.merchantSim.port} is already in use. ` +
        "Something else is serving conversion events — stop it before running the demo.",
    );
    process.exit(1);
  }
  throw err;
});

server.listen(config.merchantSim.port, () => {
  console.log(`merchant-sim listening on :${config.merchantSim.port} (campaign ${campaignId.slice(0, 10)}...)`);
});
