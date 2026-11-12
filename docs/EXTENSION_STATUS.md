# Reflex Perps — inspected implementation and verification status

This records the **current working tree**, including funding and the user-approved real testnet vault custody core. It is not evidence of a published release, public deployment or independent audit. Ponytail is mandatory in `../AGENTS.md`. Owner-signed strategy accounting and local PAPER execution are now implemented; genuine autonomous trading remains disabled. The latest checkpoint below supersedes earlier implementation-gap descriptions.

## Executed local verification

All commands below were rerun successfully for the Phase 0 checkpoint (Rust with `--locked`). [PHASE0_DECISIONS.md](PHASE0_DECISIONS.md) records source/dirty-state provenance and the accepted scope/constraints/sequence; it grants no real trading or deployment authority.

| Command (from `NEARFlow/`, unless noted) | Actual result | Scope |
| --- | --- | --- |
| `cargo test --manifest-path contracts/exchange/Cargo.toml` | **78 passed** | Matching, collateral/margin, authorization/replay, P&L/liquidation, withdrawals, funding/controller and rounding |
| `cargo test --manifest-path packages/funding/Cargo.toml` | **3 passed** | Default cap/slope/sign properties, deadband/EMA/invalid inputs, shared rate vectors |
| `cd client && npm test` | **33 passed** | 27 existing TS tests + 3 funding and 3 strategy wallet-helper tests; withdrawal-outcome tests cover strategy callbacks too |
| `cd client && npm run test:sandbox` | **2 integrations passed** | Builds actual Wasm, NEAR Sandbox 2.14.0 exchange/funding and isolated vault receipt-chain execution |
| `cd client && npm run lint` | **Passed** | Existing client ESLint command |
| `cd client && npm run typecheck` | **Passed** | Next route generation + TypeScript |
| `cd client && npm run build` | **Passed** | Production Next build; not a browser smoke test |

Rust reports an upstream future-incompatibility warning for `wasmparser 0.78.2`; passing tests do not remove dependency-review obligations. Initial test expectation failures were corrected to reflect bounded index-checkpoint truncation and observation-based EMA; the final runs above passed. Sandbox assertion failures are exposed by this toolchain as Wasm traps; unit tests verify specific rejection conditions, and the Sandbox test checks receipt rejection/state before continuing.

Sandbox exercised test-token registration/deposits, two-party matching, finalized API positions/fills, close, equal-opposite funding, token resolver refunds, liquidation and failed/successful withdrawal callbacks. Extended funding receipts exercised current-epoch application, replay rejection, lazy settlement and owner-only controller configuration. All keys/receipts were local Sandbox only.

## Current Phase 3 checkpoint (supersedes earlier inventory/counts)

[PHASE3_ASSURANCE.md](PHASE3_ASSURANCE.md) records implemented C0–C2 local PAPER funding ingestion, immutable group policy, persistence/cooldown/shared flow-cost limits, one market entry/epoch, fresh per-leg binding checks and external-change stop/cancel/reconcile/repair. **107 TS tests (18 new loop/source tests)**, **111 exchange + 4 funding Rust tests**, **3 actual-Wasm Sandbox integrations**, **2 Chromium funding fixtures**, lint/typecheck/build pass. Sandbox now advances two actual consecutive funding epochs (adaptive 400 → 720 ppm) into an allowed PAPER hedge; virtual depth changes, actual balances/OI do not. Pure fixtures also verify a net-negative deliberate skip, overlapping workers, outage/restart and late partial receipt recovery.

No public deployment/spending, genuine spot/delegation, unattended service or real two-leg execution is authorized. V8 and S0–S3 broader runtime/security/empirical gates remain open. Test-only clock/current-ingress-time and stderr-backpressure fixes plus earlier failed-run dispositions are documented; finalized source freshness was not relaxed.

## Historical Phase 2 checkpoint

See [PHASE2_ASSURANCE.md](PHASE2_ASSURANCE.md): V0–V7 local owner-signed accounting and PAPER lifecycle/policy/sizing/reconciliation/monitoring/repair/unwind/audit are implemented. **111 exchange Rust tests**, **4 funding Rust tests**, **89 TypeScript tests (including 23 new PAPER cases and a wallet-helper test)**, **3 actual-Wasm Sandbox integrations**, lint, combined typecheck and production build pass. Sandbox now exercises attributed strategy escrow, matching, counterparty close and fixed-owner real payout. The local PAPER CLI demonstrates a declined opportunity, hedge, residual exposure and bounded unwind without moving tokens.

V8's refusal/readiness gate is tested, but genuine signed two-leg execution, delegated on-chain policy, approved spot venue, S1–S3 and D1 remain blocked. No public deployment, genuine hedge, operator spending or independent audit is claimed. Historical F4 hashes certify only that earlier review checkpoint; these new storage layouts require fresh deployment and later security/release review.

## Historical Phase 1 checkpoint (supersedes Phase 0 counts above)

Current working-tree regression after the approved F4 review: **98 exchange Rust tests, 4 funding Rust tests, 65 TypeScript tests, 3 actual-Wasm Sandbox integrations, 2 desktop/mobile Chromium browser cases; lint/typecheck/build passed**. F3's versioned MODEL_PAPER review/calibration is complete for its stated local scope: 30,240 feedback runs with negative/no-adoption results, separate spot/perp custody, capped bilateral settlement and full provenance/replay exports. See [evaluation.md](evaluation.md) and [feedback model](calibration/feedback/MODEL.md); these are not runtime Guardian or independent-audit evidence.

F2 now shares configured freshness across contract views/readiness/keeper and atomically projects stored/effective rates from finalized snapshots. Actual keeper-process restart across a bounded stale-oracle gap is Sandbox-verified. Trade funding disclosures and locally expiring quote/readiness pass desktop/mobile Chromium fixture checks, including signed units/direction, keyboard focus, fallback and RPC failure. F2 is complete for this local scope, not public wallet verification.

F4 now adds seeded actual-contract config/partial-close sequences, 512 parameter corners, legacy Market incompatibility checks and fail-closed finalized code/data deployment preflights. Added price/size/collateral extremes, minimum-notional/free-collateral rejections and funded root-state round-trip/legacy-layout rejection. Actual deployment CLI Sandbox rehearsal passes fresh deployment, funded-storage no-op refusal, interrupted-code refusal and replacement recovery. Deployment now awaits FINAL receipts before dependent reads. The user approved replacing independent F4 sign-off with implementation-agent review, now completed in [F4_REVIEW.md](F4_REVIEW.md) with content hashes, findings/dispositions and three added assurance tests. [PHASE1_ASSURANCE.md](PHASE1_ASSURANCE.md) provides current evidence. This is not an independent audit or public deployment/spending approval.

Operator `reflex-operator-49c6b7.testnet` exists and has funded-state evidence from finalized read-only RPC. Credentials are outside Git; no exchange/token deployment or real automation is implied. No operator funds were spent by this local assurance work.

## Existing functionality inspected

- **MATCHED_ORDERBOOK**, isolated bilateral pairs: equal long/short size, no LP/vAMM or useful aggregate OI skew.
- One exchange ledger for NEP-141 custody, accounts, reservations, margins, nonces, positions, isolated strategy allocations and settlement. `audit()` checks internal liability equality and strategy pending/request aggregates; vault Sandbox also reconciles actual token custody.
- P&L/funding capped by available bilateral collateral; either counterparty can close a pair. These constrain any future spot/perp hedge.
- Trusted independent oracle publisher, freshness checks, bounded order book and history, wallet-signed manual trading and read-only finalized HTTP projections.
- Responsive existing Trade terminal, account/position/order/payment history, wallet callback and deposit/withdraw flows. Interactive browser/wallet verification is still missing.

## Earlier funding extension now locally verified

- `packages/funding`: Rust baseline/adaptive premium-only math, bounded versioned parameters, EMA, continuous soft deadband, smoothing, caps; TypeScript bigint previews and shared vectors.
- `contracts/exchange/src/controller.rs`: deterministic contract-derived mark/index input, hourly epochs, replay protection, owner-only revisioned configuration and old-index accrual before updates.
- `math.rs`/`trading.rs`: preserved lazy pair checkpoints, fractional remainder and collateral-capped zero-sum transfers; oracle/rate-lifetime accrual limits.
- Keeper invokes eligible controller epochs; market API uses precise ppm rate where available.
- See [FUNDING.md](FUNDING.md) for equations and fallback behavior. This is not evidence of calibrated or production-safe adaptive funding.

## Real testnet vault custody — verified locally

- `contracts/exchange/src/strategy.rs`: immutable-owner strategy records, paid bounded storage, direct NEP-141 strategy deposits, isolated transfers from/to free exchange balance, pause, fixed-owner external withdrawals and terminal empty close.
- Withdrawal requests reserve collateral, resolve once and restore the same strategy on failure. No keeper/admin withdrawal path or arbitrary payout recipient exists. Strategy funds are unavailable to manual trading; no strategy trading is enabled.
- `client/lib/near/strategy.ts` provides wallet-authorized helpers; `outcome.ts` rejects unsuccessful strategy withdrawals.
- 26 vault Rust tests and a new actual-Wasm vault Sandbox integration cover isolation, owner/token authorization, caps/overflow/storage, callback replay/forgery, pending/out-of-order receipts, refunds, token payout and failed-payout restoration.
- [VAULT_DESIGN.md](VAULT_DESIGN.md) records actual ABI, accounting, limits and verification. This is real test-token custody, not an autonomous hedge/yield vault.

## Missing or incomplete

- Public wallet/browser round trips and broader U0 terminal integration beyond the locally verified funding disclosure.
- Independent audit and full archived-state migration certification were not performed; they are not claimed by the user-approved local F4 implementation-agent review. Mandatory fresh deployment remains. F3 model calibration does not validate live liquidity or remove last-fill manipulation risk.
- **Autonomous hedge execution**: trade reservations, policies, spot/perp adapters, expected-net-carry sizing, execution state machine/reconciliation, monitoring/repair, restricted delegation and position unwind. Basic isolated custody and owner settled-custody exits are implemented.
- Actual runtime funding–vault feedback loop and anti-chasing/shared-liquidity controls. The internal MODEL_PAPER experiment is not their connected implementation.
- Broader S0–S3 actual-adapter/Guardian integration and empirical validation. Seeded F3 controller/feedback comparisons, vault ablations, provenance exports and negative research results now exist.
- Broader integrated controller/cost indicators and Autopilot panel in Trade; final user-facing Reflex Perps branding; wallet/automation browser E2E and integrated threat review.
- Genuine spot execution. Chart spot feeds are not executable venue integration. `CONTRACTS.vault` currently aliases exchange custody, not a delta-neutral strategy vault.

The standalone Stress Lab page, migration and NFT work are **removed from scope**, not unfinished deliverables. Internal stress simulations remain required testing infrastructure.

## Deployment and approval blockers

- The named operator account and funding are verified; dedicated exchange/oracle/token roles, public deployed contract/token IDs, wallet flows and release gates remain unverified. Operator provisioning is not deployment approval.
- **Fresh deployment required:** controller metadata changed Market serialization and vault maps/counters changed root Exchange serialization; no migration entrypoint exists. Do not deploy this over incompatible funded state. Drain/close under original code, then use a new contract account and explicit deposits.
- A PAPER or mixed PAPER-spot/testnet-perp strategy must be labeled per leg; it cannot be advertised as a live onchain vault.
- The user approved real testnet custody before PAPER hedge work. Genuine delegation, spot venue, public deployment and publication still require operator-controlled authorization/evidence; do not treat this custody approval as an unrestricted trading mandate.
