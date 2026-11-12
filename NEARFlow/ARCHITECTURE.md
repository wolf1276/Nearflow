# Reflex Perps — existing architecture and proposed integrated extension

**Perpetual trading that adapts to the market.**

NEAR hackathon track: **Unstoppable DeFi**.

Status: funding, user-approved **real testnet vault custody**, isolated owner-signed strategy trading and **local PAPER** execution/risk/replay (V0–V7) are implemented. Genuine autonomous two-leg execution (V8), public deployment and terminal Autopilot integration remain separately gated. The caller-driven finalized funding → bounded PAPER loop (C0–C2) is implemented too. Current checkpoints/limitations: [Phase 2](docs/PHASE2_ASSURANCE.md) and [Phase 3](docs/PHASE3_ASSURANCE.md). Ponytail is mandatory in `AGENTS.md`.

The Stellar-to-NEAR migration is already complete. This is an extension of the existing NEAR exchange, not a migration, exchange replacement or new matching engine. `NEARFlow/`, Rust crate names, event namespaces and contract identifiers are legacy implementation names; the finalized product is **Reflex Perps**. User-facing rebranding is pending, not silently claimed complete.

## 1. Product and scope

Phase 0 scope, custody constraints and implementation sequence are accepted in [docs/PHASE0_DECISIONS.md](docs/PHASE0_DECISIONS.md). Same-ledger isolated allocations and PAPER-first hedge testing are the selected path; genuine delegation, spot venue and public deployment remain separately reviewed gates, not approved execution interfaces.

Two systems form one product:

1. **Adaptive Funding Engine:** deterministic, guarded premium-responsive funding, alongside a conventional baseline.
2. **Autonomous Delta-Neutral Vault:** isolated user strategies that evaluate expected net carry, seek approximately offsetting spot-long/perp-short exposure, and manage execution, delta, costs and margin under explicit policy.

The central research hypothesis is their interaction:

```text
validated market observations
    → authoritative funding rate/index
    → conservative opportunity evaluation
    → policy-approved independent spot/perp orders
    → reconciled fills and changed market premium/depth
    → fresh observation at the next allowed decision epoch
```

There is no direct guardian-to-funding-rate override. Vault orders may affect executable book pressure/premium; they do **not** reduce an invented aggregate long-minus-short OI skew in this matched market. Any improvement in stability, carry or hedge risk must be measured, including failures and zero responsiveness.

**In scope:** preserve Trade; integrate funding information and an Autopilot/Vault panel; real isolated testnet strategy custody (implemented); PAPER-first hedge execution testing; reproducible internal simulations; separately gated genuine NEAR/spot automation; honest testnet demo.

**Excluded:** standalone Market Stress Lab page or Lab navigation; NFT contracts/strategy NFTs/marketplaces; migration tasks; unrelated perp rewrites; pooled vault-share/NAV system; unrestricted automated withdrawals; guaranteed neutrality/returns, production-readiness or unsupported live spot/Intents claims. Internal deterministic stress tests are required infrastructure, not a separate consumer product.

## 2. Inspected implementation map

Paths are relative to `NEARFlow/`. “Proposed” modules below do not exist yet.

| Concern | Existing authoritative module | Verified scope / gap |
| --- | --- | --- |
| Custody/registration/deposit/withdraw | `contracts/exchange/src/{lib,strategy}.rs` | Allowlisted token, isolated strategy allocations, owner-only exits and receipt recovery locally tested |
| Data and serialized state | `contracts/exchange/src/{model,strategy}.rs` | Account, Order, Pair, Market, Funding, Strategy and bounded pending strategy withdrawal records |
| Order book/positions/close/liquidation | `contracts/exchange/src/trading.rs` | Bounded price-time matched book; collateral-capped bilateral lots |
| Fixed-point risk/funding math | `contracts/exchange/src/math.rs` | U256 intermediates, lazy index, payer-margin caps, pair remainder |
| Market/account/risk/event views | `contracts/exchange/src/views.rs` | Finalized-chain projections, bounded history; some freshness checks still fixed at 60 sec |
| Funding controller | `contracts/exchange/src/controller.rs`; `packages/funding/` | Current working-tree baseline/adaptive math and contract integration verified locally; further hardening/calibration pending |
| Test collateral | `contracts/test-token/src/lib.rs` | Six-decimal faucet test token; not real USDC |
| Oracle/keeper/deployment | `client/scripts/{oracle,keeper,deploy-testnet,near-runtime}.ts`, `build-contracts.mjs` | Trusted publisher; operational scripts, not an autonomous vault service |
| Wallet/amounts/receipts/RPC | `client/lib/near/{contracts,strategy,wallet,units,outcome,rpc}.ts` | Native NEAR signing, custody wallet helpers and callback validation; no strategy delegation |
| HTTP backend | `client/app/api/[...path]/route.ts`, `client/lib/near/venue-api.ts` | Read-only chain projection; POST returns 405; no strategy/simulation/proposal API implemented |
| Main terminal | `client/app/trade/[market]/page.tsx`; `client/features/trade/components/` | Existing responsive manual trading UI; no Autopilot panel |
| Funding UI | `FundingHistoryTable.tsx`, market read models | User payment history/rate projection; no integrated controller explanation, rate archive or projected-cost panel |
| Internal research/automation | `packages/{sim,adapters,risk,vault}/`, `services/guardian/` | F3 model research, local durable PAPER execution/policy/reconciliation/risk/replay and C0–C2 finalized-read PAPER coordinator exist; genuine on-chain feedback, unattended operation and full seeded runtime/security gates remain missing |

`client/config/networks.ts` maps `engine`, `vault` and `orderGateway` to the existing exchange. A frontend alias named `vault` is **not evidence of a separate delta-neutral vault**. External spot chart/ticker feeds are also not a spot execution integration.

## 3. Existing exchange — preserve these semantics

### Market model and atomic state

The market is **MATCHED_ORDERBOOK**, not a pool counterparty or vAMM. `trading.rs::execute_match` creates equal long/short size in one pair. Both OI views report the same matched aggregate. Order-arrival imbalance, premium and defensible executable-book measurements may be meaningful; aggregate long OI minus short OI is not.

`Exchange` holds collateral, accounts, order escrow, pair margins, positions, funding checkpoints and event rings. Margin does not move cross-contract during a fill. The only current asynchronous asset boundary is NEP-141 deposits/withdrawals. Preserve near-sdk 5.28.0 and existing money paths unless a narrowly scoped, tested extension requires change.

### Custody invariant and permissions

```text
token custody = manual available + order escrow + pair margins + strategy available
              + insurance + global pending withdrawals
```

`audit()` checks the internal custody-liability accounting. Actual token custody also needs receipt/token-balance reconciliation; an internal equality alone is not external custody proof.

`ft_on_transfer` accepts only the configured immutable token. Unsupported messages, unregistered senders and cap overflow return unused amounts to the token resolver. `msg="insurance"` is an irrevocable donation. Registration prepays 32,768 bytes/account; no registration refund/unregister path exists.

Wallet mutations derive authority from `predecessor_account_id`, not request-supplied ownership. Orders retain monotonically increasing account nonces. Most value-changing methods require one yoctoNEAR. Withdrawal reserves free collateral before NEP-141 transfer, then restores it on callback failure. Locked order/position margins cannot be withdrawn. Full-access exchange keys can replace code and remain an explicit custody risk.

### Execution, margin and liquidation

- Bounded price-time order book, self-trade prevention, margin-plus-fee reservation, expiries, post-only/IOC and bounded automatic matching. Opening fills stay within the existing 5% oracle band.
- Initial margin at least 10% (up to 10x testnet leverage); independently configured maintenance below initial margin.
- Each fill creates a bilateral pair with both sides' margin. Either owner may close part/all at a fresh oracle, affecting both counterparties. Reduce-only closes owned opposing lots at the oracle rather than resting as new exposure.
- Profits are capped by the counterparty's remaining escrow; losses are capped by own margin. There is no uncapped cross-margin claim against unrelated users. Opening fee: 3 bps/side. Liquidation fee: up to 50 bps of notional, bounded by loser equity, split between insurance and liquidator.
- Pause stops new risk; oracle-valid reductions/closes, cancellation and available-balance withdrawal remain possible. An oracle outage can block closing/liquidation; automation must not invent a fallback execution price.

**Vault implication:** a perp short can disappear through counterparty close or liquidation, and capped perp gains can cease offsetting spot losses in a crash. “Delta-neutral” is an approximate local exposure target, not a global payoff guarantee. Monitor actual remaining pair size, collateral caps, pending orders and spot inventory; pause/repair/reduce under policy when the hedge ceases to be effective.

### Oracle

A separate trusted account publishes positive 1e18-scaled USD/base prices, capped at 1e27, monotonically timestamped, no future timestamp and <=10-second ingress delay. The publisher script uses at least two independent feeds and rejects >3% divergence. Contract authority trusts the publisher; it does not verify source aggregation proofs. Default freshness is 60 seconds, with shorter per-market funding configuration supported in `fresh_market`; all consumers still need consistency review.

## 4. Adaptive Funding Engine — current checkpoint and open work

Detailed equations/parameter bounds are in [docs/FUNDING.md](docs/FUNDING.md).

### Current working-tree behavior (locally verified, not publicly deployed)

- `packages/funding` implements fixed-point linear BASELINE and experimental nonlinear ADAPTIVE. Premium/rates use 1e6 scale, per 3600-second interval; positive means longs pay shorts. Prices/index use 1e18. Signed arithmetic truncates toward zero.
- Both modes consume the same premium EMA. Adaptive additionally uses a continuous soft dead zone, superlinear premium term, rate smoothing, absolute cap (default 20 bps/hour) and step cap (default 4 bps/update).
- `update_funding` derives the signal from an independent market index and recent opening fill; no caller-provided rate/mark and no OI-skew input. Current default bounds: index age 60 sec, fill age 300 sec, absolute premium 10%.
- Once per current chain-hour epoch; strictly increasing epochs, no backfill. `publish_price` accrues the old index before changing the index observation but does not step the controller.
- Owner-only `configure_funding` checks parameter schema/revision, accrues the old index, resets rate/EMA and consumes the current epoch; it cannot reset pair checkpoints or repeatedly initialize adaptive rates in the same hour.
- Stale oracle rejects updates and unsafe execution. Accrual stops at oracle expiry or one hour after rate application. Missing/stale/divergent mark produces explicit zero-rate fallback at an eligible update; no synthetic oracle index is created.
- `trading.rs::apply_funding` keeps existing lazy pair checkpoints, fractional payment remainder and equal-opposite collateral-capped transfers. Settlement replay at the same index has no effect. Index checkpoint truncation is bounded but not partition-independent; do not promise exact unrounded accrual.

### Still required

- Unify configured freshness across readiness, keeper, proposals and risk views. Distinguish stored hourly quote from actively accruing funding in API/UI.
- Decide/review **hysteresis**: current behavior is a continuous soft deadband plus EMA/rate memory, not a separate stateful enter/exit switch. Do not mark full hysteresis/calibration complete merely because smoothing exists.
- Review last-fill manipulation, sparse-market ring eviction, epoch-boundary updates and observation-based EMA across gaps; introduce any alternative estimator only with bounded, reproducible evidence.
- Extend property tests across accepted parameters and settlement/configuration sequences; review conservation, partial-close dust and payer exhaustion. Calibrate using internal scenarios, including negative outcomes.
- Integrate controller mode, interval, payer direction, freshness/fallback, rate/payment history and projected costs into Trade.

### Storage compatibility is a release gate

Current controller metadata changes `Market` Borsh layout, and strategy maps/counters change the root `Exchange` layout. **An initialized older exchange cannot be safely upgraded with this working tree. No migration method exists.** Close/settle/withdraw under the old code, then use a separately provisioned fresh exchange account and explicit new deposits. Never reset or delete funded state. An additive future strategy design must document its own storage compatibility and funding/storage costs.

## 5. Isolated owner-signed custody/trading and local PAPER execution

### Isolated accounting without a second exchange ledger

The user approved real testnet custody before hedge simulation. `contracts/exchange/src/strategy.rs` partitions allocations inside the existing ledger: direct allowlisted-token deposits and transfers from free manual collateral credit only strategy available. Owner-only release, pause, fixed-recipient withdrawal and settled empty close are implemented. Bounded unique withdrawal requests reserve funds before NEP-141 transfer and restore the same strategy on failure; callbacks cannot be replayed. Owner-signed strategy endpoints now reuse the existing trading engine with isolated escrow, attributed pair margins/funding/proceeds and same-book nonce/history. Manual paths cannot consume strategy positions. No delegated or genuine autonomous execution is enabled.

See [docs/VAULT_DESIGN.md](docs/VAULT_DESIGN.md) for the actual ABI, 32,768-byte prepaid trading storage, lifetime strategy limits, cap-including-escrow/effective-margin/pending rule and verified custody invariants. The wallet helpers are in `client/lib/near/strategy.ts`; no new terminal panel or HTTP write API is implemented. Independent PAPER spot/perp adapters now provide the execution-testing layer, never a replacement for or claim on real custody.

Each strategy needs owner, fixed payout destination, execution mode per leg, policy revision/hash, allocated free reserve, order reservations, actual positions, pending receipts, funding checkpoints and costs. Start with the single supported six-decimal test collateral; additional tokens require explicit validation. No pooled shares/NAV or transferable strategy ownership is needed.

The owner must be able to pause new automation, request close and withdraw **settled, unencumbered** funds. Automation may only propose or perform contract-enforced bounded trade/reduce/repair actions. It cannot change owner, policy or payout destination, withdraw, or obtain unrestricted custody full-access keys. API authentication/function-call key labels alone are not a substitute for method-level on-chain authorization and policy enforcement.

### Opportunity and policy

```text
expected net carry over a stated, uncertain horizon
  = expected collectible short funding + expected basis change
  - entry/exit fees - spot/perp slippage - repair/reserve costs
  - any genuinely applicable borrow/custody/transfer costs
```

Do not extrapolate one rate indefinitely. Funding may reverse or be collateral-capped, the pair may close early, and executable liquidity may be absent. Reject high-funding opportunities that fail conservative net-carry, depth, reserve or risk tests.

Policy needs maximum gross notional, absolute delta and duration, minimum margin/reserve, slippage, daily turnover, cooldown, entry/exit persistence, participation/depth limit, minimum net carry, total execution/repair budget, retry limit and separately authorized open/reduce/close permissions. Prices/money stay fixed-point; decisions are deterministic for a versioned input snapshot.

### Execution and state machine

Implemented local execution components: `packages/{vault,risk,adapters}/` and `services/guardian/`. `npm run vault:paper` from `client/` runs a clearly labeled deterministic fixture. The Guardian has independent durable PAPER legs, immutable local policy, conservative sizing, cumulative reconciliation, bounded surplus reduction/owner unwind and economic/audit replay. There is no deployed continuous scheduler, real delegated signer, genuine spot adapter or public mutation API. Local actor confirmation is not cryptographic wallet authentication. See `docs/PHASE2_ASSURANCE.md` for storage/restart/archive procedures and exact scope.

```text
DRAFT → QUOTING → OPENING → HEDGED
                    ↘       ↕
                     REPAIRING → PAUSED
OPENING / HEDGED / REPAIRING → UNWINDING → SETTLED
PAUSED → authorized safe UNWINDING (only when venue/oracle permit)
Declined proposals remain non-executing; settled is terminal.
```

- Spot/perp orders, partial fills, remaining sizes, cancellations and finality are independent; no invented atomic two-leg execution.
- Stable strategy/epoch/leg/client-order IDs; durable idempotent reconciliation before retry. Unknown transaction outcome is not permission to duplicate exposure.
- Watch oracle/venue freshness, actual delta, funding reversal, margin, counterparty close/liquidation, collateral caps, quote/depth changes and remaining cost budget.
- Repair only within policy. Otherwise pause new allocations, expose residual risk and permit authorized bounded reductions when safe. Manual stop does not pretend pending orders disappeared.
- Every decision records policy hash/revision, input snapshot, funding epoch/config revision, reason, result, receipts and costs—including skipped opportunities and failures.

### Execution honesty

PAPER adapters neither move tokens nor credit chain balances. Real testnet perps require signed/restricted on-chain execution. Genuine spot execution requires a chosen venue, custody/finality review and real receipt/balance evidence; no such adapter exists. If spot is PAPER and perp is testnet, display each leg's mode and call the strategy a mixed-mode demonstration, not a live onchain vault. “Break hedge” failure injection is local/PAPER/sandbox only.

## 6. Controlled feedback loop

Implemented for local PAPER scope in `services/guardian/{funding-source,funding-loop}.ts` and `packages/risk/feedback.ts`; see `docs/PHASE3_ASSURANCE.md`. The actual finalized Sandbox connector passes two consecutive funding epochs → allowed PAPER hedge → reduced virtual depth, with unchanged real balances/matched OI. At least two persistent epochs, one group entry/epoch and shared flow/cost reservations bound chasing. Every leg gets a fresh binding check; changes/expiry/outages stop/cancel/reconcile. Local fixtures separately demonstrate deliberate net-negative rejection. This is not an autonomous signed venue, a deployed daemon or proof that PAPER orders changed chain premium.

The guardian consumes finalized observations/configuration, not a magical profitable signal. One eligible evaluation per strategy/epoch, explicit quote TTL, entry/exit thresholds/persistence, cooldown, turnover/participation caps and reserve/cost limits prevent recursive funding chasing.

Reconcile own market impact and external actions before making another decision. A successful short order may change premium/book depth while matched OI remains balanced. Do not count an intended order as market improvement. Multiple strategies must share a conservative liquidity budget rather than simultaneously assume the same depth is available.

A new controller version, stale input, depleted depth, exhausted payer collateral, manual/counterparty close or unresolved fill invalidates old plans. Expected negative net carry should cause a documented skip, hold, bounded unwind or pause—not an automatic trade for every high funding quote.

## 7. Existing terminal integration, not a separate lab

Keep `TradeTerminalGrid`, chart/book/ticket, wallet/deposit flows, positions and history. Extend:

- `MarketHeader`, `MarketDataProvider`, `OrderEntry`, `PositionsTable`, `FundingHistoryTable`: transparent experimental controller mode, funding units/interval/direction, effective freshness/fallback, actual history and assumed projected costs.
- Proposed `client/features/autopilot/` panel in the same trading terminal: policy/allocation confirmation, independent leg status, delta, reserve/margin, realized funding, realized/unrealized/net P&L after fees, recent decisions and manual controls.
- Clear execution-mode labels per leg; disconnected/loading/empty/error/reconciliation states; responsive keyboard-accessible controls. Manual Trade remains default.
- `venue-api.ts` / existing route: retain finalized read projections and wallet/on-chain authority. Any new bounded quote/proposal endpoints are **proposed**, not existing writes. API auth cannot move funds or override policy. Rate-history archival must be explicitly added; the current 512-event ring is not a full archive.

Internal simulation output may appear in an optional developer/debug view, never a standalone Stress Lab product or the main demo interface.

## 8. Internal validation and research

F3's `packages/sim/` model and calibration CLI already provide versioned internal research; Phase 2 adds separate runtime PAPER adapters/Guardian. S0–S3 broader shared-scenario/runtime/security integration remains work and must not be marked complete by either local checkpoint. Both funding arms receive identical versioned seeds, exogenous index paths, order arrivals, liquidity and fees; endogenous trader/vault response is explicit. Include controller-only and vault-on/off ablations to measure the interaction, not just two rate formulas.

Scenarios: directional buy/sell demand, spikes/reversals, crash, sparse liquidity, partial/failed fills, stale/conflicting oracles, liquidation, counterparty close, capped-payoff hedge failure, overshoot and expensive rebalancing. Model this exchange's actual bilateral collateral-capped payouts, not synthetic uncapped pool debt.

At least three seeds per scenario; sensitivity sweeps include zero, weak and strong response. Measure premium/reversion, rate peaks/jumps, oscillation, margin/liquidation/drawdown, delta size/duration, repairs/turnover, fees, realized/unrealized net P&L and settlement residuals. Publish observed failure/no-improvement cases. Deterministic JSON/CSV exports contain scenario/schema version, seed, source revision/dirty-state provenance, parameters and outputs. Exported simulations are never transaction evidence.

## 9. Verification, trust and release gates

Current local evidence: **111 exchange Rust tests, 4 funding Rust tests, 107 TypeScript tests (including 23 Phase 2 PAPER and 18 Phase 3 loop/source cases), 3 NEAR Sandbox integrations, 2 Chromium funding fixtures, lint, combined client/backend typecheck and production build passed**. These are working-tree results, not a clean published release or exhaustive audit. Sandbox exercised actual Wasm token refunds, matching/close/liquidation/withdrawal recovery and funding update/replay/settlement/owner configuration. Native wallet serialization and redirect handling have unit tests, not interactive browser-wallet verification.

Missing: genuine autonomous trading/delegation/spot and on-chain feedback, integrated Autopilot UI/API, full integrated browser/security gates, unattended scheduling and public deployment/wallet verification. Local isolated owner-signed custody/trading, F3 research model and PAPER execution/risk/replay are implemented, not a genuine live delta-neutral vault. An operator account has been provisioned separately; no public exchange/token deployment or live hedge receipt is claimed. Local Sandbox is not public NEAR testnet.

Primary trust risks: custody upgrade keys; authorized oracle and last-fill manipulation; token callbacks; strategy allocation/authority; external spot custody/finality; partial execution/retries; capped bilateral hedge failure; automation oscillation/costs. Remain testnet/test-funds-only, not audited or production ready.

Implementation order and per-task acceptance/tests are in [todo.md](todo.md). Internal PAPER testing can start before public provisioning. Real automation requires tested on-chain restrictions and separate adapter approval; public demo claims require funded operator accounts, fresh compatible deployment, actual signing/receipts and final regression/security gates.

## 10. Demo target

100–120 seconds inside Trade: actual NEAR perp trade → funding response → user approves policy/allocation → strategy accepts or declines a hedge on net costs → reversal/imbalance → bounded repair/reduce/pause → visible funding/P&L/costs/margin. Use a controlled local/PAPER failure only with explicit labeling. If genuine spot is unavailable, show the limitation rather than inventing an onchain vault. The differentiator is a coherent, risk-checked funding–hedging loop with measured limitations.
