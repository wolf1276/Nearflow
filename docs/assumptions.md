# Reflex Perps — inspected constraints and unresolved decisions

## Verified codebase facts

- NEAR migration is complete. Preserve existing near-sdk **5.28.0**, NEAR wallet paths and exchange rather than introducing another chain/matching engine.
- **MATCHED_ORDERBOOK** with isolated bilateral lots. `trading.rs::execute_match` creates equal long/short size; `views.rs::open_interest` reports equal aggregates. No LP counterparty, vAMM inventory or defensible net-OI skew exists.
- `contracts/exchange/src/lib.rs::Exchange` is authoritative for collateral, order escrow, pair margin and withdrawals. Frontend engine/vault/orderGateway aliases refer to that exchange. Real isolated strategy custody is implemented in `strategy.rs`; autonomous strategy trading does not exist.
- One immutable allowlisted six-decimal NEP-141 test token. Faucet test collateral is not real USDC. No supported additional-token onboarding or live spot custody is implied.
- Prices are independent trusted-publisher observations, 1e18 USD/base, positive and <=1e27, monotonically timestamped and <=10 seconds old on ingress. Oracle script uses at least two feeds and rejects >3% divergence. Execution does not trust browser chart prices.
- Default freshness is 60 seconds; `fresh_market` now supports shorter configured ages. Hard-coded 60-second consumers in views/API/keeper remain an explicit F2 hardening task, not a verified consistent system.
- Max 10x testnet leverage; isolated margins; collateral-capped bilateral P&L/funding. Either counterparty may close a pair. Pause permits oracle-valid closes/reductions, cancellation and unlocked withdrawals; stale oracle can block close/liquidation.
- Funding uses one signed cumulative index and lazy pair/remainder settlement. Current working-tree controller supports BASELINE/ADAPTIVE, premium EMA, soft deadband, caps, bounded parameters, once-per-hour epochs and owner configuration. The old 10-bps-per-hour oracle-tick controller is not the current working-tree behavior.
- Market serialization changed with funding metadata and root Exchange serialization changed with strategy custody maps/counters: **fresh deployment required**, no safe in-place migration implemented. Existing funded state must never be reset.
- Existing main interface is `client/app/trade/[market]/page.tsx` with chart/book/ticket/positions. Backend is finalized read-only projection, not an execution relay or guardian service.

## Vault risk assumptions that require design and tests

1. Local delta neutrality does not guarantee offsetting payoffs: capped short gains can stop covering spot losses, funding can exhaust payer collateral and a counterparty can close the perp leg.
2. Genuine spot/perp execution is asynchronous and non-atomic; pending, partial and failed fills need independent reconciliation. External venue custody/finality must be explicitly chosen and reviewed.
3. Isolated strategy allocation must partition real spendable balances, not copy them into another ledger. No pooled share/NAV accounting is necessary for this scope.
4. Automation may trade/reduce only within contract-enforced owner policy. A service key or authenticated API is not permission to withdraw, replace owner or redirect payouts.
5. Expected net carry is uncertain and must include both-leg entry/exit/repair costs, depth, margin/reserve, possible rate reversal and collectible bilateral funding. High nominal funding alone is not sufficient to enter.
6. Funding and vault activity form endogenous feedback; liquidity budgets, persistence/cooldown, turnover/cost caps and anti-recursion controls are required. Beneficial stabilization is a measured hypothesis, not an assumption.

## Extension points and remaining work

| Need | Reuse | Proposed extension |
| --- | --- | --- |
| Signals/controller | `controller.rs`, `packages/funding`, market views | consistency, hysteresis/sparse-market review, calibrated bounded parameters |
| Strategy custody | implemented `strategy.rs`, accounts and withdrawal callbacks | isolated allocations/owner exits verified; add explicit trading reservations and strategy positions, not a second exchange ledger |
| Execution/authority | wallet/receipt code, contract order/close checks | PAPER-first independent adapters; later explicitly restricted delegation |
| Monitoring/repair | positions, health, liquidation views | deterministic policy/state machine, idempotent reconciliation, bounded repair/pause/unwind |
| Controlled feedback | finalized controller state and actual matched fills | conservative opportunity coordinator and shared liquidity/turnover budgets |
| Internal validation | pure math and Sandbox | proposed `packages/sim`, versioned fixtures and CLI; **no standalone Lab page** |
| Frontend | existing Trade terminal and payment history | integrated funding and Autopilot panel, no replacement trading UI |
| Backend | existing read-only API | bounded validated strategy reads/quotes/proposals; real writes retain on-chain authority |

## Evidence boundary

Current local results: **78 exchange Rust, 3 funding Rust and 33 TS tests passed**; 2 Sandbox receipt-chain integrations, lint, typecheck and production build passed. See [EXTENSION_STATUS.md](EXTENSION_STATUS.md) for exact scope. These are current working-tree results; broader security/property/browser tests remain open.

Real isolated custody was verified in local Wasm Sandbox, including token payout and failure recovery. No public deployment, interactive browser-wallet trade, genuine spot adapter or autonomous hedge vault was verified. `.env.local` is absent. Operator-funded accounts and actual transaction/receipt evidence are prerequisites for a public demo claim. Sandbox is not public testnet; PAPER is not onchain.

## Phase 0 decisions and remaining approvals

Phase 0 scope/constraints/sequence are accepted in [PHASE0_DECISIONS.md](PHASE0_DECISIONS.md): isolated same-ledger strategy allocations, fixed-owner payouts and PAPER-first hedge execution. The user approved real testnet custody first; its implemented accounting/ABI/limits are documented in [VAULT_DESIGN.md](VAULT_DESIGN.md). Review strategy trading policy/reservations before implementation, and hysteresis/sparse-market semantics, real spot venue feasibility and delegated execution separately. The final product is Reflex Perps with internal stress testing; migration, NFTs, unrelated features and a standalone Market Stress Lab are excluded.
