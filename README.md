# ConvertRail

<p align="center">
  <img src="assets/convertrail.png" alt="ConvertRail" width="480">
</p>

A neutral settlement rail for performance marketing, built on [Arc](https://www.arc.io/). Every conversion claim is checked by deterministic rules, fraud is refused on-chain in real time, and verified conversions are paid to publishers instantly in USDC — full amount, per conversion, no payout thresholds. From net-30 to one second.

**[convertrail.xyz](https://convertrail.xyz)** · **[live dashboard](https://demo.convertrail.xyz)** — the reference run, every row re-derived from Arc · **[docs](https://docs.convertrail.xyz)**

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
3. A **deterministic verification layer** gates every claim: duplicate detection (each conversion carries a *nullifier* — a unique fingerprint the contract accepts only once), evidence-hash validation against the signed conversion event, timing-anomaly checks, and a funding-graph test that refuses a claimant which is not an independent party.
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
| `scripts/` | Wallet provisioning, demo orchestrator, end-to-end acceptance harness |

## Verification model, honestly

The deep problem in conversion settlement is that the conversion event originates off-chain, inside the advertiser's systems — the data producer is the paying party. This MVP does not pretend to solve that with cryptography:

- **Publisher-side fraud is policed deterministically.** Duplicate claims are refused by the contract itself (the nullifier can only be accepted once), fabricated claims fail evidence-hash validation, and anomalous timing patterns are rejected — all with permanent on-chain evidence.
- **Advertiser-side underreporting is constrained by mechanism design**, not cryptography: verified claims auto-settle unless the advertiser objects within the dispute window, so stalling and silent shaving of submitted claims don't work.
- **Full symmetry is roadmap:** web-proof verification of conversion events (zkTLS-class suppliers), so neither side has to trust the other's systems — see below.

The verifier in this MVP is a service applying published deterministic rules, with its policy hash committed on-chain and every verdict permanently queryable. It is auditable, not trustless — and the distinction is stated rather than blurred.

## Circle stack

| Tool | How ConvertRail uses it | Status |
|---|---|---|
| **Nanopayments** | The headline mechanic. Every verified conversion is paid on its own — instant, gas-free, full amount, no threshold. The settlement module signs one EIP-3009 authorization per conversion and settles it through the Gateway facilitator (`@circle-fin/x402-batching`) — a median round trip of 940 ms across the 50 payments of the reference run. | Integrated |
| **Gateway** | The layer underneath Nanopayments: the paying wallet holds a USDC balance in Gateway, each authorization is verified off-chain in a few hundred milliseconds, and settlement lands on-chain in batches. | Integrated |
| **Circle Wallets** | The wallet that pays publishers is a Circle developer-controlled wallet. It signs every per-conversion authorization through Circle's signing API; the private key is never in this repository. Arc is not one of Circle's managed chains, so the wallet is created on the virtual EVM-TESTNET chain and Circle signs while this repository broadcasts. It is an EOA by requirement — Gateway verifies EIP-3009 by ECDSA recovery — and it never sends a transaction of its own, because provisioning credits its Gateway balance with `depositFor`. | Integrated |
| **USDC on Arc** | The entire economy of the demo. Campaign budgets, escrow accounting, publisher payouts, and gas are all denominated in USDC. | Integrated |
| Paymaster | Not applicable here. Paymaster exists to pay gas in USDC on chains where gas is something else; on Arc gas already *is* USDC, so `CampaignEscrow` provisions publisher gas directly at campaign creation. | Not applicable |
| Circle Contracts | Not used. The three contracts are hand-written Solidity, deployed with Foundry and source-verified on the explorer; the escrow's cap, dispute-window, and refusal logic is specific enough that a template deployment would not carry it. | Not used |
| CCTP / StableFX | Cross-chain and cross-border publisher payouts. | Roadmap |

Signing through Circle costs a network round trip: in a paired measurement of the same loop, a local key paid in a median of 524 ms against the Circle wallet's 952 ms. Both are instant next to the net-30 terms this replaces, and `CIRCLE_WALLET_ID` selects between them without a code change.

## Deployed on Arc testnet

Chain ID `5042002`. All three contracts are source-verified — the logic below can be read on-chain, not just in this repository.

| Contract | Address |
|---|---|
| `AgentRegistry` | [`0xB76d859523f14D8cf66304086c727EE08bc5d449`](https://testnet.arcscan.app/address/0xB76d859523f14D8cf66304086c727EE08bc5d449) |
| `ConversionRegistry` | [`0x0Df89eAAa1abae9AE01558B7149604857e29B4Ca`](https://testnet.arcscan.app/address/0x0Df89eAAa1abae9AE01558B7149604857e29B4Ca) |
| `CampaignEscrow` | [`0x1421cE35dD2Cb1Cc291eE1728B1AB091330acF2f`](https://testnet.arcscan.app/address/0x1421cE35dD2Cb1Cc291eE1728B1AB091330acF2f) |

## Running it

Prerequisites: Node 24+, [Foundry](https://getfoundry.sh) for the contracts, and an Arc testnet wallet funded with USDC from the [Circle faucet](https://faucet.circle.com/).

```bash
npm install
cp .env.example .env      # set FUNDER_PRIVATE_KEY to your funded testnet key
npm run provision         # generate agent wallets, fund them, register roles, deposit into Gateway
npm run demo              # drive the full adversarial loop against Arc testnet
```

`npm run provision` is idempotent: it writes `.wallets.json` (gitignored), tops up only what is below its floor, and fails loudly with the wallet named if anything is short.

`npm run demo` starts every component — merchant source, publisher agents, fraud agent, verifier, settlement, advertiser agent — and drives the loop to at least 50 on-chain settlements. It is an acceptance gate, not a screensaver: it exits non-zero unless the settlements land, every recognized payout has a matching payment, at least one claim is rejected, at least one duplicate is reverted on-chain, the advertiser agent reallocates budget autonomously, the fraud agent is paid nothing, and escrow accounting reconciles against the payment stream.

One operational note: conversion ids are deterministic and nullifiers are consumed on submission, so each run needs an unused `campaign.name` in `demo.config.json`.

Watch it live:

```bash
cd dashboard && npm install && npm run dev   # http://localhost:4700
```

The dashboard reads live chain state for the campaign named in `demo.config.json`, alongside the payment and fraud evidence the last run wrote.

### Deploying it

[demo.convertrail.xyz](https://demo.convertrail.xyz) is this, deployed. The dashboard is a plain Next.js app with no database. Where there is no local run to read, it falls back to the reference run committed under `dashboard/reference-run/`, so a deployed build shows the same evidence. Those records are never taken on trust: a payment appears only when it matches its `PayoutRecognized` event on claim, publisher, amount and transaction hash, and a duplicate refusal appears only after its transaction is re-fetched from Arc and confirmed reverted.

One setting matters. The dashboard scans from the campaign's first block to the chain head, which is right during a live run and wrong for a finished one — the head keeps moving, so each request scans a widening stretch of empty blocks. Bound it when deploying a completed campaign:

```bash
CAMPAIGN_FROM_BLOCK=55148863
CAMPAIGN_TO_BLOCK=55149673
```

Full list of settings and their defaults: `dashboard/.env.example`.

Tests:

```bash
npm test                    # canonical hashing, verifier rules, reallocation policy, dashboard parsers
cd contracts && forge test  # escrow accounting, dispute window, duplicate refusal, invariants
```

## What a run proves

A clean rehearsal on campaign `poc-demo-12` (Arc testnet, blocks `55148863`–`55149673`) completed with no restart, no recovery step, no manual payment, and no operator intervention:

| | |
|---|---|
| Conversions settled and paid | 50 — one payment each, 50 distinct Gateway references |
| Recognized in escrow | 5,000,000 atomic USDC, exactly equal to the sum of payments |
| Median per-conversion payment | 940 ms, signed by the Circle wallet |
| Fabricated claims refused on evidence | 7 |
| Bot traffic refused on timing | 7 |
| Linked identities refused on the funding graph | 5 |
| Duplicate claims refused by the contract | 17 reverted transactions |
| Autonomous budget reallocations | 1 — away from the fraud agent, reason `QUALITY_DIVERGENCE` |
| Paid to the fraud agent, across both its identities | 0 |

Every refusal belongs to the fraud agent; no honest publisher claim was refused. Each deterministic check refused something in this run: the contract itself reverted the duplicates, evidence-hash validation caught the fabricated claims, and the timing rule caught conversions arriving 300 ms after their click — traffic no human generates.

The fourth class is the one the other three cannot see. The fraud agent registered a second publisher identity, funded that wallet from its own, and claimed its conversions from the fresh address. Those conversions are real signed events with human timing, so evidence and timing both pass; what refuses them is the funding graph, read from the same chain anyone else can read. Two identities paid for out of one wallet are one operator, and an operator referring itself is not a referral.

Every number is chain state: the events, the verdicts, the refusals, and the reallocation can be read back from the contracts above without trusting this file.

## Status

Built for the **Programmable Money Hackathon** (Encode Club × Circle × Arc), Agentic Economy track. The full loop described here runs end to end on Arc testnet today, and the [dashboard](https://demo.convertrail.xyz) is deployed with the reference run in it. What remains is the demo video, not missing machinery.

## Roadmap

- **Web-proof conversion verification** — zkTLS attestations of conversion events, replacing trust in the advertiser's reporting with verifiable proofs of it.
- **Confidential referee** — verification inside confidential compute, so neither side reveals raw campaign data to the other.
- **Cross-chain payouts** — CCTP for publishers who want settlement on other chains, StableFX for non-USD payout currencies.
- **Dispute resolution** — the MVP records disputes with their evidence on-chain; structured resolution comes after.

## Team

**Levent Ceyhan — LeventLabs.** Fifteen years on the demand side of this market: Google Ads account strategist, then seven years running performance marketing at Xylem, then independent work in the same field. ConvertRail is a settlement problem watched from inside it — publishers waiting out net-30, advertisers paying for traffic nobody could verify, and both sides arguing from their own dashboards.

The engineering half comes from LeventLabs' work on confidential coordination in regulated finance. [AttestRail](https://attestrail.com) enforces eligibility and exposure rules over fully encrypted on-chain state on Zama's FHEVM, publishing only the final decision bit and never the attributes behind it (Zama Developer Program, Builder Track winner). An earlier AML prediction network on Canton let institutions share calibrated risk signals without sharing the data underneath (Canton Construct 2025 winner).

That is where the confidential-referee line on the roadmap comes from. It is the same shape as this problem: a rule applied to inputs neither side wants to reveal, with only the verdict made public. ConvertRail does it in the open today — deterministic rules, published policy hash, every verdict queryable — because being auditable now beats being confidential later. The next step is doing it without either side exposing its campaign data.
