// Demo load driver (R12.3 / task 3.7): drives the full five-beat adversarial
// loop at demo scale and lands >=50 verified-conversion settlements on-chain,
// or exits non-zero. It does NOT reimplement the orchestration — the e2e
// harness is the single fail-loud driver (spawns merchant/advertiser/publishers/
// fraud/verifier/settlement, collects chain events, gracefully drains, and
// reconciles escrow == payouts). This entrypoint just sets demo-scale targets
// and delegates, so the demo and the acceptance gate can never diverge.
//
// Prerequisites (kept separate, per the runbook): wallets provisioned
// (`npm run provision`) and a FRESH campaign name in demo.config.json — demo
// conversionIds are deterministic, so each run needs an unused campaign name
// (nullifiers are consumed at submit). Watch it live at the dashboard (:4700).
//
//   The five beats (Strategy §6), all real on-chain state:
//     setup    — advertiser agent funds escrow + publishes rules
//     flow     — publisher agents earn instant per-conversion USDC payouts
//     attack   — fraud agent is refused on-chain (revert + REJECTED verdict)
//     autonomy — advertiser agent reallocates budget away from fraud
//     close    — escrow accounting reconciles against the payment stream

process.env.E2E_TARGET_SETTLED ??= "50";
process.env.E2E_DEADLINE_MS ??= String(30 * 60_000);

console.log(
  `[demo-load] driving the full adversarial loop to >=${process.env.E2E_TARGET_SETTLED} on-chain settlements ` +
    `(deadline ${Number(process.env.E2E_DEADLINE_MS) / 60_000} min, fail-loud on any missed target)`,
);

await import("./e2e.ts");
