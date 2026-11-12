# V0 strategy reservation design and review

## Scope / decision

The user's instruction to proceed with V0 authorizes local design, implementation and testing of strategy trading reservations/accounting. Preserve isolated same-ledger allocations, immutable owner/fixed payout and fresh-deployment-only policy. No delegated signer, automation, spot execution, public deployment or operator spending is authorized.

Design review by the implementation agent, not an independent audit, before implementation:

- Extend the existing Order with an optional strategy ID and Pair with one optional strategy ID per side. `None` retains manual accounting. Strategy IDs are chosen only through owner-authorized strategy endpoints; callers cannot attach a strategy ID to a manual order or arbitrary counterparty side.
- Keep each strategy's available balance, bounded order/position lists, nonce, history and trading statistics in that strategy record. Reuse the existing trading engine via a temporary Account-shaped projection and a single matching persistence helper; this projection is not a second stored/spendable ledger. Manual account available/lists/statistics are never used to cover strategy trades.
- Shared engine transitions debit that exact book: available → order escrow → pair margin + insurance fee + same-book refund; funding changes pair margins equally/oppositely; partial/full close and liquidation return only that side's payout to that side's book. Liquidator rewards remain manual available, as before. Global custody counts global order/pair margins once, not again inside strategy totals.
- Each strategy is fixed to its recorded market; opening requires an unpaused strategy/exchange/market and fresh oracle. Pause blocks both new opens and matching previously resting strategy orders. Owner can cancel while paused/stale and reduce/close while paused when oracle-valid; counterparty closes and permissionless liquidation/funding settlement retain existing semantics.
- Owner-signed place/cancel/close methods are separate from manual entrypoints. Manual cancel/reduce/close cannot spend or close the owner's strategy side. Explicit strategy close must match the supplied strategy's side. A manual counterparty can still close its own side, closing the bilateral pair and returning the strategy's payout to the strategy, not its owner balance.
- Strategy available is free reserve, not collateral available to manual trading. Release/withdraw can spend only that reserve. Empty close additionally requires no orders or positions. Cap checks include stored order escrow, attributed pair margins and pending withdrawals, preventing locked funds from freeing allocation capacity. Accrued trading/funding gains may exceed the deposit/allocation cap: never discard or redirect proceeds; further allocations then reject until below cap.
- Order/funding/trade/position projections carry attribution. Manual account read models exclude the strategy side; separate bounded strategy reads expose its orders/positions/accounting. Strategy accounting shows available, escrow, funded margin, pending and total separately without pretending unrealized P&L is withdrawable.
- Preserve global limits and per-book 16-order/32-position/32-history bounds. Prepay 32,768 bytes per strategy (up from custody-only 4,096) to cover trade history, list/map growth and the four-request queue; measure worst-case storage in tests.
- Existing Strategy/Order/Pair/Trade/Funding bytes become incompatible. No migration is provided. Never upgrade or reset initialized custody, including the earlier V0a/F4 checkpoint; drain/close under original code and deploy fresh only after separate release approval.

## Pre-implementation threat review

Main failure paths to test: wrong owner/strategy/market, manual-path bypass, shared nonce/history confusion, strategy pause with resting orders, cross-book refunds, partial fills/cancels, funding and close payouts routed to manual balances, counterparty closure, liquidation, stale oracle exits, locked-fund withdrawal/release, cap bypass via escrow/margins/pending and storage underpayment. Audit must detect incorrect strategy references/list attribution, not merely a conserved global sum.

Decision: implement these bounded owner-signed accounting primitives only. V2 policy/delegation and V4–V8 autonomous execution remain absent. No generic executor or unrestricted strategy-spending API is introduced.

## Implementation evidence

Implemented and verified locally: 111 exchange Rust tests (13 new strategy-trading cases), including isolated partial-match/cancel/close routing, manual/foreign-strategy authorization, funding/liquidation attribution, pause of resting orders, locked withdrawal/cap protection, effective lazy-funded margin caps, duplicate-reference audit and populated-book storage. The actual-Wasm vault Sandbox integration additionally checks owner-signed escrow/matching, manual-close rejection, counterparty close, same-book proceeds and real token payout/custody reconciliation. All three Sandbox integrations pass. See `PHASE2_ASSURANCE.md` for the full checkpoint and limits.

Review disposition: no new blocking defect identified in the tested local owner-signed accounting scope. No independent audit or delegated authority approval is implied. Strategy/Order/Pair/Trade/Funding storage is incompatible with earlier checkpoints; fresh deployment is mandatory. Historical F4 review hashes do not certify this extension.
