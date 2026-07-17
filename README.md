# ConvertRail

A neutral settlement rail for performance marketing, built on [Arc](https://www.arc.io/). Every conversion claim is checked by deterministic rules, fraud is refused on-chain in real time, and verified conversions are paid to publishers instantly in USDC — full amount, per conversion, no payout thresholds. From net-30 to one second.

## The problem

Performance marketing is a structurally adversarial market. Advertisers and publishers transact billions annually under mutual distrust:

- **Publishers don't trust advertisers.** Conversions happen inside the advertiser's systems, and the party that reports the data is the party that pays. Underreporting has no neutral arbiter.
- **Advertisers don't trust publishers.** Fake signups, duplicate conversions, and bot traffic drain budgets, and detection today is retroactive, off-chain, and opaque.
- **Settlement is slow and gated.** Outside the top tier, net-30/net-60 terms and $50–500 minimum-payout thresholds persist because legacy settlement is expensive per transaction. Working capital sits locked; small publishers are structurally excluded.

Both sides operate on self-reported dashboards. Disputes are resolved by relationship power, not evidence. Autonomous agents make this worse, not better: an agent's self-reported conversion deserves less trust than a human's, and agents cannot operate on net-30 relationships. "How does an autonomous agent get paid for verified work?" is the native question of the agent economy — this rail is an answer.

## What it does

The full adversarial loop runs agent-to-agent, with no humans in the flow:

1. An **advertiser agent** funds a USDC escrow and publishes campaign rules on-chain: the offer, the price per conversion (the CPA — *cost per action*), total budget, per-publisher caps, and the verification policy.
2. **Publisher agents** drive conversions and submit claims with evidence.
3. A **deterministic verification layer** gates every claim: duplicate detection (each conversion carries a *nullifier* — a unique fingerprint the contract accepts only once), evidence-hash validation against the signed conversion event, and timing-anomaly checks.
4. A verified conversion is paid **instantly and gas-free, in full, per conversion** via Circle Nanopayments.
5. A claim that passes verification **auto-settles unless the advertiser objects within a dispute window** — silence is acceptance, so the referee constrains both sides, not just publishers.
6. A fraudulent claim is **refused by the contract itself, on-chain**, and the attempt is permanently logged with its evidence.
7. The advertiser agent monitors verified-conversion quality per publisher and **autonomously reallocates budget** away from low-quality traffic — decision logic tied to real on-chain signals, no human intervention.

Every agent in the money path is deterministic by design. Agents that move money need auditable decision logic, not improvisation.

## Why Arc

Minimum payout thresholds exist because settlement is expensive. A $0.50 conversion cannot be paid individually on invoice-based rails, and not on general-purpose chains with volatile gas either. On Arc, gas *is* USDC, fees are predictable and dollar-denominated, and Nanopayments makes a per-conversion micro-payment instant and gas-free — payments aggregate off-chain and settle on-chain in batches through Circle Gateway. That removes the economic reason payout thresholds exist. This product is only viable on exactly this stack; the chain is the point, not a deployment target.

## Architecture

```
                   ┌──────────────────────────────────────────────────────┐
  Arc testnet      │  AgentRegistry     roles: advertiser/publisher/verifier│
  (USDC = gas)     │  CampaignEscrow    budget, rules, caps, dispute window,│
                   │                    reallocation, refusal path          │
                   │  ConversionRegistry claims, duplicate refusal (reverts)│
                   │                    verdicts, evidence hashes           │
                   └────▲─────────▲──────────▲──────────▲───────────────────┘
                        │         │          │          │
                  fund +│   claims│    claims│   verdicts│ reallocate
                  rules │         │          │          │
   ┌────────────────────┴─┐ ┌─────┴────┐ ┌───┴─────┐ ┌──┴──────────────────┐
   │ advertiser agent     │ │ publisher│ │ fraud   │ │ verifier service     │
   │ fund · monitor ·     │ │ agents   │ │ agent   │ │ deterministic checks │
   │ reallocate           │ │ ×2       │ │ (demo   │ │ posts verdicts       │
   │ + operational wallet │ └──────────┘ │ antag-  │ │ holds no funds       │
   └──────────┬───────────┘              │ onist)  │ └──────────────────────┘
              │ per-verified-conversion  └─────────┘
              │ instant gas-free USDC payment (Nanopayments)
              ▼
       publisher wallets        dashboard: live settlement feed · fraud log ·
                                auto-settle countdowns · explorer links
```

| Component | Role |
|---|---|
| `contracts/` | CampaignEscrow, ConversionRegistry, AgentRegistry (Solidity, Arc) |
| `agents/` | Advertiser, publishers, fraud agent — deterministic policies (TypeScript) |
| `verifier/` | Deterministic verification service; posts on-chain verdicts; holds no funds |
| `merchant-sim/` | Simulated conversion source emitting signed events (demo stand-in for an advertiser's conversion system) |
| `settlement/` | Nanopayments integration and escrow reconciliation |
| `dashboard/` | Live settlement feed, campaign state, fraud log (Next.js) |
| `scripts/` | Wallet provisioning, demo load script, repo checks |

## Verification model, honestly

The deep problem in conversion settlement is that the conversion event originates off-chain, inside the advertiser's systems — the data producer is the paying party. This MVP does not pretend to solve that with cryptography:

- **Publisher-side fraud is policed deterministically.** Duplicate claims are refused by the contract itself (the nullifier can only be accepted once), fabricated claims fail evidence-hash validation, and anomalous timing patterns are rejected — all with permanent on-chain evidence.
- **Advertiser-side underreporting is constrained by mechanism design**, not cryptography: verified claims auto-settle unless the advertiser objects within the dispute window, so stalling and silent shaving of submitted claims don't work.
- **Full symmetry is roadmap:** web-proof verification of conversion events (zkTLS-class suppliers), so neither side has to trust the other's systems — see below.

The verifier in this MVP is a service applying published deterministic rules, with its policy hash committed on-chain and every verdict permanently queryable. It is auditable, not trustless — and the distinction is stated rather than blurred.

## Circle stack

| Tool | Role | Status |
|---|---|---|
| Circle Wallets | Isolated dev-controlled wallet per agent | Core |
| Circle Contracts | USDC escrow, campaign rules, claim registry | Core |
| Nanopayments | Instant, gas-free, per-conversion payout — the headline mechanic | Core |
| Gateway | The settlement layer under Nanopayments (off-chain aggregation, batched on-chain settlement) | Core, via Nanopayments |
| CCTP / StableFX | Cross-chain and cross-border publisher payouts | Roadmap |

Paymaster is deliberately absent: on Arc, gas is already USDC, so the escrow provisions publisher gas directly.

## Status

Built for the **Programmable Money Hackathon** (Encode Club × Circle × Arc), Agentic Economy track. The build lands in this repository during the hackathon window (July–August 2026); this README precedes the code. Run instructions will arrive with the components they run.

## Roadmap

- **Web-proof conversion verification** — zkTLS attestations of conversion events, replacing trust in the advertiser's reporting with verifiable proofs of it.
- **Confidential referee** — verification inside confidential compute, so neither side reveals raw campaign data to the other.
- **Cross-chain payouts** — CCTP for publishers who want settlement on other chains, StableFX for non-USD payout currencies.
- **Dispute resolution** — the MVP records disputes with their evidence on-chain; structured resolution comes after.

## Team

LeventLabs.
