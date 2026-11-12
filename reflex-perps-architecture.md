# Reflex Perps — finalized scope and architecture entry point

**Perpetual trading that adapts to the market.**

Primary track: **Unstoppable DeFi**.

Status: funding and user-approved real testnet custody implemented and verified locally; hedge automation and UI remain roadmap work.

This file supersedes the earlier Lab-centric extension blueprint. The repository has now been inspected; the previous statement that its internals were uninspected is obsolete.

## Authoritative documents

- [ARCHITECTURE.md](ARCHITECTURE.md): inspected exchange, current funding checkpoint, proposed isolated vault, feedback loop, trust boundaries and terminal integration.
- [todo.md](todo.md): task IDs, P0/P1/P2 priorities, existing/missing behavior, exact existing or explicitly proposed modules, dependencies, acceptance criteria, required tests and status.
- [docs/EXTENSION_STATUS.md](docs/EXTENSION_STATUS.md): actual verification evidence and missing functionality.
- [docs/FUNDING.md](docs/FUNDING.md): implemented funding equations/units/bounds, cadence/fallback and mandatory fresh-deployment requirement.
- [docs/assumptions.md](docs/assumptions.md): inspected constraints and unresolved decisions.
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md): dependency order and approval gates, replacing the old fixed commit-count plan.

## Final decisions

Phase 0 is complete for baseline/scope/constraints/sequence; see [docs/PHASE0_DECISIONS.md](docs/PHASE0_DECISIONS.md) for the approval boundary and re-executed regression evidence. This does not authorize genuine automated trading, a spot venue or deployment.

1. Product: **Reflex Perps**. Existing NEARFlow directory/crate/storage/event identifiers are not renamed by a documentation update; user-facing code rebranding is a future scoped task.
2. The NEAR migration is complete. Preserve the existing NEAR matched-orderbook exchange, authoritative custody, matching, paired positions, margin/liquidation, settlement and trading UI. Do not build another exchange.
3. Adaptive funding and autonomous delta-neutral hedging are one controlled product loop, not independent demo features. Evaluate net collectible funding after costs and risk; decline unsuitable opportunities.
4. This exchange matches equal long/short size. Use validated independent-index/mark premium; do not invent meaningful aggregate OI skew or apply a pool-capacity formula to it.
5. Real testnet strategy custody is now implemented inside the existing ledger, with isolated allocations, immutable owners and replay-safe fixed-owner withdrawals; see `docs/VAULT_DESIGN.md`. No strategy trading is enabled. Hedge execution testing starts with explicit PAPER adapters; genuine spot/perp automation is separately gated by venue feasibility, custody/finality and on-chain restricted authority. Automation cannot withdraw or redirect payouts.
6. The perp has collateral-capped bilateral P&L, and counterparties can close pairs. Both invalidate a naive assumption that a spot/perp hedge remains effective indefinitely; the risk engine must detect and respond.
7. Keep the existing Trade terminal primary; add funding indicators and an Autopilot/Delta-Neutral Vault panel there. **No standalone Stress Lab page/navigation.** Keep deterministic scenario simulation as internal test/research CLI infrastructure only.
8. No migration work, NFT/strategy-NFT marketplace, unrestricted autonomous custody, unrelated feature expansion, guaranteed returns or production-readiness claims. Unsupported spot/Intents/bridge integrations are not implied.
9. Simulations, local Sandbox, mixed PAPER/testnet execution and genuine public testnet receipts must be labeled distinctly. No deployment addresses, transactions or outcomes may be fabricated.
10. Current funding and strategy custody storage are incompatible with initialized older Market/Exchange layouts. Follow the fresh-account deployment/drain policy in FUNDING.md; never reset funded state.

## Research objective

Test whether bounded premium-responsive funding plus conservative, independently reconciled hedge execution can improve defined market/exposure metrics under stated assumptions. Compare identical seeded exogenous conditions, include vault-on/off ablations, weak/zero response and actual failure/no-improvement cases. A negative result is valid evidence, not a reason to fabricate an advantage.

## Next work

The user approved real testnet vault custody first; that core is implemented and locally verified. Continue with funding hardening and bounded strategy execution design, preserving the existing ledger. Genuine spot integration, delegated trading authority, public deployment and publication remain separately reviewed gates; no deployed address or full hedge functionality is implied. Ponytail is mandatory in `AGENTS.md`.
