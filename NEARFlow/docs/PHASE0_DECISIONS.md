# Phase 0 — scope, custody and execution gates

## Status and approval boundary

**Accepted for phased implementation** under the user's instruction to follow `todo.md` and complete Phase 0. This records scope/design constraints, not permission to deploy, trade autonomously with real collateral, publish, or use operator credentials. Earlier approval of real testnet custody remains limited to V0a. No additional user confirmation of a particular spot venue, delegated signer or production risk limits is implied.

A0–A1 establish the inspected/local baseline; A2 accepts the constraints and sequence below. Detailed trading interfaces, permission schemas and adversarial tests remain V0/V2/V6/V8 deliverables. Closing Phase 0 does not mark those implementations or release gates complete.

## Decisions

1. **Preserve the authoritative exchange and Trade terminal.** `lib.rs`/`model.rs` own state, `trading.rs` owns matching and bilateral settlement, `math.rs` owns fixed-point risk/funding calculations, and `views.rs` exposes projections. `client/config/networks.ts` aliases engine/vault/orderGateway to that same exchange. No exchange rewrite or second spendable ledger.
2. **Use isolated same-ledger strategy allocations.** Extend the implemented custody model in [VAULT_DESIGN.md](VAULT_DESIGN.md), rather than pooled shares/NAV or new strategy accounts. Future strategy orders must reserve only that strategy's available funds; positions, margin, fees, funding and refunds must retain strategy attribution. No manual/other-strategy balance may cover its losses. Trading implementation requires a reviewed reservation/settlement design and isolation tests before enabling spending.
3. **Keep owner and payout immutable.** Only the owner may allocate, change policy, pause, request close or withdraw settled unencumbered funds. External payouts remain fixed to the owner. Reservations and pending receipts cannot become withdrawable merely because pause/close was requested. Preserve same-strategy failure recovery, cap-including-pending and replay protection.
4. **PAPER first for hedge execution.** Independent spot/perp PAPER adapters use separate simulated inventory and explicit per-leg modes; neither deposits to, credits nor spends chain collateral. A PAPER strategy is not an automation switch on an existing real custody allocation. Unknown receipts must reconcile before retry; no atomic two-leg assumption.
5. **Deny genuine automation by default.** The current custody contract grants no strategy trade authority. No keeper/admin withdrawal path, generic arbitrary-call executor, full-access custody key or unsigned HTTP mutation is approved. Future delegated trading must enforce owner-confirmed policy revision/hash, strategy ownership, action permissions, nonce/epoch, notional/delta, reserves/margin, freshness, slippage, costs, turnover, cooldown and retries on the authoritative execution path. Off-chain checks alone do not authorize real spending. Exact ABI/key mechanism requires separate review and adversarial evidence.
6. **No spot venue selected.** Chart feeds are not executable liquidity. Genuine spot remains blocked until venue, supported asset, custody, fees/depth, receipt finality and failure recovery are reviewed and separately approved. If unavailable, retain labeled PAPER hedging plus manual NEAR trading; mixed modes are not a live delta-neutral vault.
7. **Treat the hedge as fallible.** Matched long/short OI is equal, not a skew signal. Bilateral gains/funding are payer-collateral-capped; counterparty close/liquidation can remove the perp hedge. Oracle outage can prevent unwind. Expected net carry must include both-leg entry/exit/repair costs, uncertain horizon and collectible funding; high quoted funding alone never authorizes entry.
8. **Preserve storage and evidence boundaries.** Changed Market/Exchange layouts require a fresh account after draining/closing old state under original code; never reset funded state. PAPER, actual-Wasm local Sandbox and public testnet are separate evidence categories. No public address, receipt, profitable return, stabilization or audit claim is established by this phase.

## Implementation sequence

Follow [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) and task dependencies in [../todo.md](../todo.md):

- F2 consistency → F3 behavior specification; review V0 reservations before implementing strategy trading.
- V1 PAPER adapters and S0 internal harness → V2–V7 policy, sizing, reconciliation, monitoring, owner exit and replay.
- C0–C2 PAPER feedback and S1–S2 evaluation → F3 calibration/F4 accounting and fresh-deployment assurance.
- U0–U3 inside Trade → S3 regression/security and D0 documentation.
- Separate approval/evidence for V8 real adapters/delegation, D1 public deployment and D3 publication. Real custody automation stays disabled until applicable F4, V0–V7, S1–S3 and venue/authority gates pass.

No standalone Stress Lab, migration, NFT/marketplace, pooled NAV, unrestricted withdrawals or unrelated feature expansion.

## Phase 0 regression checkpoint

Re-executed against the existing dirty working tree based on commit `01cc71aa6b49f8e5cd014ab30a75728d32dda50d` (not a clean release):

| Command from `NEARFlow/` | Result |
| --- | --- |
| `cargo test --locked --manifest-path contracts/exchange/Cargo.toml` | 78 passed |
| `cargo test --locked --manifest-path packages/funding/Cargo.toml` | 3 passed |
| `cd client && npm test` | 33 passed |
| `cd client && npm run test:sandbox` | 2 passed; actual Wasm, local receipt chains |
| `cd client && npm run lint` | Passed |
| `cd client && npm run typecheck` | Passed |
| `cd client && npm run build` | Passed |

The Sandbox suites include intentional rejected receipt paths; these are not public testnet transactions. Rust retains the upstream `wasmparser 0.78.2` future-incompatibility warning. Baseline code/tests were preserved; this phase changes documentation only.

Not checked: interactive browser/wallet flows, public deployment, independent audit, genuine spot or autonomous strategy execution. Funding freshness inconsistencies (F2), broader accounting/storage assurance (F4), and unimplemented trading permissions remain blockers for real automation, not exceptions granted by this decision.
