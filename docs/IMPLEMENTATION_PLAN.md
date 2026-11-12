# Reflex Perps — proposed dependency-based implementation order

This supersedes the old 35-commit plan. No fixed commit count, standalone Stress Lab, migration or NFT work remains. [../todo.md](../todo.md) is the authoritative task/status list; [../ARCHITECTURE.md](../ARCHITECTURE.md) distinguishes inspected implementation from proposed modules.

**The user approved real testnet custody before PAPER hedge implementation.** V0a now implements and locally verifies that core; see [VAULT_DESIGN.md](VAULT_DESIGN.md). Autonomous hedge execution, public deployment and genuine spot remain gated. Ponytail is mandatory in `../AGENTS.md`.

## Order and gates

| Step | Roadmap tasks | Deliverable and gate |
| --- | --- | --- |
| 0 (complete) | A0–A2 | Baseline reverified; scope, same-ledger isolation, fixed-owner payouts, PAPER-first sequence and release boundaries accepted in [PHASE0_DECISIONS.md](PHASE0_DECISIONS.md). Real authority/venue interfaces remain separate review gates. |
| 1 | F2, F3 specification | Align effective freshness/fallback/rate expiry across contract, risk/read views and keeper; decide hysteresis/sparse-market behavior. Current equations remain the experimental reference until changes are approved. |
| 2 (parallel) | V0a (done), V0, V1, S0 | Real isolated custody and owner exits are implemented/tested. Extend with explicit strategy trading reservations/policy, independent PAPER hedge adapters and deterministic internal harness. PAPER fills cannot credit or move real collateral. |
| 3 | V2–V7 | Policy/state machine → conservative net-carry sizing → stable execution/reconciliation → watchdog/bounded repair → owner pause/unwind/settled withdrawal → decision replay. No genuine custody automation before authorization/isolation tests pass. |
| 4 | C0–C2, S1–S2 | Connect PAPER feedback loop; test shared liquidity/cooldown/turnover/anti-recursion limits. Identical-seed comparisons and vault-on/off ablations include negative results. Feed evidence back into F3 calibration and C1 limits. |
| 5 | F3 completion, F4 | Freeze reviewed funding parameters/behavior; property-test accounting, configuration and rounding; rehearse safe fresh-account deployment. No incompatible in-place upgrades. |
| 6 | U0–U3 | Integrate funding and Autopilot into the existing Trade terminal, with per-leg modes, cost/risk/P&L and manual controls. No separate Lab route. API projections/proposals never substitute for on-chain authority. |
| 7 | S3, D0 | Full browser/security/CI/regression and clean-clone reproduction; document threat model, research limitations, provenance and new-vs-existing work. |
| 8 (separate approval) | V8, D1 | Operator-funded accounts and fresh public deployment; real perp delegation and genuine spot venue separately approved/tested. If spot is unavailable, retain explicit PAPER strategies; do not claim a live vault. |
| 9 | D2–D3 | Rehearse integrated 100–120 second trade → funding → permitted strategy → reversal/imbalance → safe response demo; publish only with operator-authorized repository/accounts and actual evidence. |

Funding-only UI work U0 can be staged after the funding gate without waiting for the complete Autopilot panel. Internal PAPER feedback tests do **not** depend on real execution/public provisioning; this avoids a research/deployment dependency cycle. Provisioning accounts can happen earlier operationally, but no release or genuine-hedge claim bypasses F4/S3/V8 gates.

## Validation policy

- A checked task must cite executed tests or concrete inspection for its exact scope, not merely a file's existence.
- Keep existing Rust/TS/Sandbox regressions passing. Run focused tests per change and all suites/lint/typecheck/build at gates.
- Simulations use the actual matched, bilateral capped model and explicit trader/vault response. Preserve shared exogenous conditions, record source/seed/parameters, and report failures.
- Readiness, data freshness and policy validation must agree with authoritative contract behavior.
- New custody/permissions require on-chain enforcement and adversarial tests; a keeper key is not automatically a safe strategy authority.
- Stop on unresolved accounting, serialization, oracle, venue or delegation blockers. Never invent a deployment address, interface, live spot fill or transaction link.

## Commit/publication policy

Prefer focused commits at passing gates; no empty checkpoints or arbitrary commit quota. Keep pre-existing exchange work distinguishable from funding, vault and integration changes. Preserve history and storage/event identifiers unless a separate reviewed change requires otherwise. No push/publication or account operations without an operator-authorized destination and credentials; never commit secrets, guess an owner, force-push or bypass hooks.

## Current checkpoint

Real isolated testnet custody V0a is complete locally: 78 exchange Rust tests, 3 funding Rust tests, 33 TS tests and 2 Sandbox integrations passed, plus lint/typecheck/build. Next complete F2 consistency and design bounded strategy trading/reservations on top of the existing custody core. Genuine spot integration and delegated trading authority remain separate review gates; no public deployment is claimed.
