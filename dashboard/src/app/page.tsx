"use client";

import { useEffect, useRef, useState } from "react";

const EXPLORER = "https://testnet.arcscan.app";
const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;

interface Publisher {
  address: string;
  cap: string;
  recognized: string;
  paid: string;
  verified: number;
  rejected: number;
  settled: number;
  qualityPct: number | null;
}
interface FeedRow {
  claimId: string;
  publisher: string;
  amount: string;
  txHash: string;
  blockNumber: string;
  paymentRef: string;
  elapsedMs: number;
}
interface FraudRow {
  key: string;
  type: "REJECTED" | "DUPLICATE_REVERT";
  claimId: string;
  publisher: string;
  nullifier: string;
  evidenceHash: string;
  reason: string;
  txHash: string;
  blockNumber: string;
}
interface Realloc {
  from: string;
  to: string;
  amount: string;
  reason: string;
  newFromCap: string;
  newToCap: string;
  txHash: string;
  blockNumber: string;
}
interface Pending {
  claimId: string;
  publisher: string;
  settleAtBlock: string;
  blocksLeft: number;
}
interface DashboardState {
  campaignName: string;
  campaignId: string;
  currentBlock: string;
  exists: boolean;
  campaign: {
    advertiser: string;
    operationalWallet: string;
    pricePerConversion: string;
    budget: string;
    recognizedTotal: string;
    paidTotal: string;
    reimbursedTotal: string;
    remaining: string;
    disputeWindowBlocks: number;
  } | null;
  publishers: Publisher[];
  feed: FeedRow[];
  fraudLog: FraudRow[];
  reallocations: Realloc[];
  pending: Pending[];
  counters: {
    txCount: number; settled: number; paid: number; verified: number; rejected: number;
    duplicateReverts: number; refused: number; reallocations: number;
  };
}

const usd = (s: string) =>
  "$" + (Number(s) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/** Publisher labels: derive stable short handles from address so the demo
 * reads clean (P-1, P-2, …) without depending on any private wallet map. */
function labeler(publishers: Publisher[]): (addr: string) => string {
  const order = [...publishers].map((p) => p.address.toLowerCase());
  return (addr: string) => {
    const i = order.indexOf(addr.toLowerCase());
    return i >= 0 ? `PUB-${i + 1}` : shortAddr(addr);
  };
}

export default function Home() {
  const [s, setS] = useState<DashboardState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ts, setTs] = useState<number>(0);
  const first = useRef(true);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        if (j.error) setErr(String(j.error).split("\n")[0]);
        else {
          setS(j);
          setErr(null);
          setTs(Date.now());
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      } finally {
        first.current = false;
      }
    };
    // Scheduled after each poll completes, never on a fixed interval. A cold
    // scan takes seconds while the interval was four, so requests overlapped —
    // and overlapping requests were what let the server append the same block
    // range twice. The server now serialises regardless; this keeps the client
    // from queueing work it cannot use.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await poll();
      if (alive) timer = setTimeout(loop, 4000);
    };
    void loop();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!s) {
    return (
      <main className="wrap">
        <Header s={null} err={err} ts={ts} />
        <p className="muted">{err ? `error: ${err}` : "Reading chain state…"}</p>
      </main>
    );
  }

  const label = labeler(s.publishers);
  const spent = s.campaign ? Number(s.campaign.recognizedTotal) : 0;
  const budget = s.campaign ? Number(s.campaign.budget) : 0;

  return (
    <main className="wrap">
      <Header s={s} err={err} ts={ts} />

      <div className="banner">
        <div>
          <span className="banner-legacy">LEGACY</span> net-30 to net-60 terms · $50–500 minimum payout thresholds ·
          per-transaction fees
        </div>
        <div className="banner-arrow">→</div>
        <div>
          <span className="banner-rail">CONVERTRAIL</span> instant, gas-free, per-conversion USDC payout · no thresholds
          · verified traffic only
        </div>
      </div>

      <div className="grid">
        {/* Settlement feed — the main surface */}
        <section className="panel feed-panel">
          <h2>
            Settlement feed
            <span className="count">{s.feed.length} paid</span>
          </h2>
          <p className="panel-note">
            Each row is one <Gloss t="conversion">verified conversion</Gloss> paid in full after its{" "}
            <Gloss t="window">dispute window</Gloss> closes. The Gateway reference confirms payment; the Arc link shows
            its escrow-recognition transaction.
          </p>
          <div className="rows scroll">
            {s.feed.length === 0 && <div className="empty">No confirmed payments yet.</div>}
            {s.feed.map((r) => (
              <div className="row" key={r.claimId}>
                <span className="tag settled">PAID</span>
                <span className="mono">#{r.claimId}</span>
                <span className="pub">{label(r.publisher)}</span>
                <span className="amt">{usd(r.amount)}</span>
                <span className="cap" title={`Gateway payment reference ${r.paymentRef}`}>
                  gw {shortHash(r.paymentRef)} · {r.elapsedMs}ms
                </span>
                <a className="link" href={txUrl(r.txHash)} target="_blank" rel="noreferrer">
                  escrow ↗
                </a>
              </div>
            ))}
          </div>
        </section>

        <div className="side">
          {/* Campaign state */}
          <section className="panel">
            <h2>Campaign</h2>
            {s.campaign ? (
              <>
                <div className="kv">
                  <span>Budget</span>
                  <b>{usd(s.campaign.budget)}</b>
                </div>
                <div className="kv">
                  <span>Escrow recognized</span>
                  <b>{usd(s.campaign.recognizedTotal)}</b>
                </div>
                <div className="kv">
                  <span>Gateway paid</span>
                  <b className="teal">{usd(s.campaign.paidTotal)}</b>
                </div>
                <div className="kv">
                  <span>Remaining</span>
                  <b>{usd(s.campaign.remaining)}</b>
                </div>
                <div className="kv">
                  <span>Price / conversion</span>
                  <b>{usd(s.campaign.pricePerConversion)}</b>
                </div>
                <div className="bar">
                  <div className="bar-fill" style={{ width: `${budget ? (spent / budget) * 100 : 0}%` }} />
                </div>
                <div className="kv small">
                  <span>
                    <Gloss t="window">Dispute window</Gloss>
                  </span>
                  <b>{s.campaign.disputeWindowBlocks} blocks</b>
                </div>
              </>
            ) : (
              <p className="muted">Campaign {s.campaignName} not found on-chain yet.</p>
            )}
          </section>

          {/* Per-publisher quality */}
          <section className="panel">
            <h2>Publishers · quality</h2>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Publisher</th>
                  <th>Cap</th>
                  <th>Paid</th>
                  <th>V / R</th>
                  <th>Quality</th>
                </tr>
              </thead>
              <tbody>
                {s.publishers.map((p) => (
                  <tr key={p.address}>
                    <td>
                      <a className="link" href={addrUrl(p.address)} target="_blank" rel="noreferrer">
                        {label(p.address)}
                      </a>
                    </td>
                    <td>{usd(p.cap)}</td>
                    <td className="teal">{usd(p.paid)}</td>
                    <td>
                      <span className="teal">{p.verified}</span> / <span className="danger">{p.rejected}</span>
                    </td>
                    <td>
                      <span className={p.qualityPct === null ? "muted" : p.qualityPct >= 50 ? "teal" : "danger"}>
                        {p.qualityPct === null ? "—" : `${p.qualityPct}%`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Auto-settle countdowns */}
          <section className="panel">
            <h2>
              Auto-settling
              <span className="count">{s.pending.length}</span>
            </h2>
            <p className="panel-note">
              Verified &amp; awaiting the <Gloss t="window">dispute window</Gloss>. Silence = acceptance.
            </p>
            <div className="rows">
              {s.pending.length === 0 && <div className="empty">Nothing pending.</div>}
              {s.pending.slice(0, 8).map((p) => (
                <div className="row" key={p.claimId}>
                  <span className="tag verified">VERIFIED</span>
                  <span className="mono">#{p.claimId}</span>
                  <span className="pub">{label(p.publisher)}</span>
                  <span className={p.blocksLeft <= 0 ? "amt teal" : "amt warn"}>
                    {p.blocksLeft <= 0 ? "settling…" : `${p.blocksLeft} blk`}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Reallocation history */}
          <section className="panel">
            <h2>
              Autonomous reallocation
              <span className="count">{s.reallocations.length}</span>
            </h2>
            <p className="panel-note">
              The advertiser agent shifts budget away from fraud on on-chain signals — zero humans.
            </p>
            <div className="rows">
              {s.reallocations.length === 0 && <div className="empty">No reallocation yet.</div>}
              {s.reallocations.map((r) => (
                <div className="row" key={r.txHash}>
                  <span className="tag realloc">{r.reason}</span>
                  <span className="pub danger">{label(r.from)}</span>
                  <span className="mono">→</span>
                  <span className="pub teal">{label(r.to)}</span>
                  <span className="amt">{usd(r.amount)}</span>
                  <a className="link" href={txUrl(r.txHash)} target="_blank" rel="noreferrer">
                    ↗
                  </a>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {/* Fraud log — full width */}
      <section className="panel">
        <h2>
          Fraud log
          <span className="count danger">{s.fraudLog.length} refused</span>
        </h2>
        <p className="panel-note">
          Fabricated claims are backed by on-chain rejection events. Duplicate attempts are included only after their
          reverted receipt and <code>submitClaim</code> calldata are verified against Arc.
        </p>
        <div className="rows scroll-sm">
          {s.fraudLog.length === 0 && <div className="empty">No refusals yet.</div>}
          {s.fraudLog.map((f) => (
            <div className="row fraud" key={f.key}>
              <span className="tag rejected">{f.type === "DUPLICATE_REVERT" ? "DUPLICATE REVERT" : f.reason}</span>
              <span className="mono">#{f.claimId}</span>
              <span className="pub danger">{label(f.publisher)}</span>
              <span className="cap" title={`nullifier ${f.nullifier}`}>
                <Gloss t="nullifier">nf</Gloss> {shortHash(f.nullifier)}
              </span>
              <span className="cap" title={`evidence hash ${f.evidenceHash}`}>
                ev {shortHash(f.evidenceHash)}
              </span>
              <a className="link" href={txUrl(f.txHash)} target="_blank" rel="noreferrer">
                tx ↗
              </a>
            </div>
          ))}
        </div>
      </section>

      <footer className="foot">
        <span>Read-only console. Rows come from Arc state plus successful Gateway payment records — no mock data.</span>
        <span className="muted">
          Glossary: verified conversion = a signed conversion event that passed deterministic checks · dispute window =
          blocks the advertiser has to object before payout · nullifier (nf) = per-conversion uniqueness tag that makes
          duplicates revert on-chain · evidence hash (ev) = fingerprint of the signed conversion event.
        </span>
      </footer>
    </main>
  );
}

function Header({ s, err, ts }: { s: DashboardState | null; err: string | null; ts: number }) {
  return (
    <header className="top">
      <div className="brand">
        Convert<span className="teal">Rail</span> <span className="sub">settlement console</span>
      </div>
      <div className="stats">
        {s && (
          <>
            <Stat label="campaign" value={s.campaignName} />
            <Stat label="on-chain txs" value={String(s.counters.txCount)} accent />
            <Stat label="verified" value={String(s.counters.verified)} className="teal" />
            <Stat label="refused" value={String(s.counters.refused)} className="danger" />
            <Stat label="block" value={`#${s.currentBlock}`} />
            <span className={`dot ${err ? "dot-err" : Date.now() - ts < 8000 ? "dot-live" : "dot-stale"}`} title={err ?? "live"} />
          </>
        )}
      </div>
    </header>
  );
}

function Stat({ label, value, accent, className }: { label: string; value: string; accent?: boolean; className?: string }) {
  return (
    <div className={`stat ${accent ? "stat-accent" : ""}`}>
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${className ?? ""}`}>{value}</span>
    </div>
  );
}

const GLOSS: Record<string, string> = {
  conversion: "A signed conversion event that passed deterministic verification.",
  window: "The number of blocks the advertiser has to object before a verified conversion auto-settles. Silence = acceptance.",
  evidence: "Fingerprint of the signed conversion event; a fabricated claim's hash matches no real event, so it is refused.",
  nullifier: "A per-conversion uniqueness tag — replaying it makes the contract revert, so duplicates are refused on-chain.",
};

function Gloss({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <abbr className="gloss" title={GLOSS[t] ?? ""}>
      {children}
    </abbr>
  );
}
