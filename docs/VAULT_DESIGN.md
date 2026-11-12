# Reflex Perps — isolated custody, strategy trading and PAPER testing

## Decision / trust boundary

Keep one authoritative exchange ledger with isolated per-owner strategy books. Real NEP-141 six-decimal test-token custody and **owner-signed perp trading** are implemented locally. Independent PAPER hedge testing lives outside the contract and never credits or spends that custody. No share token, pooled NAV, delegated executor, genuine spot adapter or automated real withdrawal exists.

See `V0_RESERVATION_REVIEW.md` for the pre-implementation accounting/threat review and `PHASE2_ASSURANCE.md` for runtime behavior, exact test scope, archival/restart procedures and genuine execution blockers.

## Accounting

```text
custody = manual available + global order escrow + global pair margins
        + strategy available + insurance + global pending withdrawals
```

Orders carry an optional strategy ID; each pair side has its own optional strategy ID. `None` preserves manual accounting. Strategy available, nonce, order/position references, bounded history and statistics form an isolated book. An Account-shaped temporary projection reuses the existing engine; it is never another persisted spendable balance.

- Allocation debits the owner's free manual collateral and credits only that strategy. Release reverses it. Neither changes total custody.
- Direct deposits accept only the immutable token predecessor and recorded strategy owner. Invalid/missing/paused/closed/over-cap destinations refund completely.
- Strategy order escrow and position margin cannot be released or withdrawn. Matching, partial-fill refunds, cancellations, funding, partial/full closes and liquidation return each side's proceeds/statistics only to its attributed book.
- A manual entrypoint cannot consume its owner's strategy position. Explicit strategy entrypoints require the immutable owner and correct strategy/market attribution. Same-owner self-trading remains forbidden across books.
- Either counterparty can close a bilateral pair; liquidation remains permissionless. A strategy's perp hedge can disappear without its owner requesting it. Capped gains may cease offsetting spot losses. These are original market semantics, not a neutrality guarantee.
- The allocation cap counts free funds, escrow, **effective lazy-funded** margin and pending withdrawals. Gains may exceed the cap; no proceeds are discarded, but further allocation rejects until there is room.
- Withdrawal debits settled free available into a unique bounded request before the token transfer. Recipient is always the immutable owner. Success reduces custody; failure restores the same strategy. Callback replay/forgery is rejected; out-of-order independent resolutions work. Pending is counted only once globally.
- `audit()` checks custody equality, pending request aggregates and strategy/manual attribution. Sandbox additionally checks actual token custody. `strategy_accounting` separates free reserve, order escrow, stored/effective funded margin and pending; unrealized P&L is never labeled withdrawable.

## Pause / close / storage

Owner pause blocks allocation/deposit, opening and matching resting strategy orders. It does not pretend pending withdrawals/orders disappeared. Owner can cancel while paused/stale, release/withdraw settled available and reduce/close at an oracle-valid bounded price. A stale oracle can block a market exit; no synthetic fallback price is invented. Closing the strategy record is terminal and requires zero free/pending custody, requests, orders and positions.

- Registration required before creation; immutable owner, market, cap and payout.
- At most 128 lifetime strategy records, 8 per owner (closed tombstones retained).
- Per strategy: at most 16 orders, 32 positions, 32 historical orders and 4 pending withdrawals.
- `strategy_storage_cost()` prepays **32,768 bytes** at the current storage-byte price; excess deposit is refunded. A test measures a populated trading book/history and its global map growth against this budget. No record deletion/storage refund or ID reuse.
- Strategy IDs/U64 and token amounts/U128 serialize as decimal strings.
- **Fresh deployment only.** Root Exchange plus Strategy/Order/Pair/Trade/Funding and funding Market layouts are incompatible with previous custody checkpoints. No migration exists. Never upgrade/reinitialize funded old storage. Drain/close under original code; obtain release approval for a new deployment.

## Contract API

Existing custody API remains: `strategy_storage_cost`, `create_strategy`, `get_strategy`, `get_strategies` (max 8), `get_strategy_withdrawal`, `allocate_strategy`, `release_strategy`, `set_strategy_paused`, `withdraw_strategy`, `close_strategy`, private `resolve_strategy_withdraw`.

All custody mutations require the owner predecessor; creation prepays returned storage cost; other owner mutations require 1 yoctoNEAR. Withdrawal needs at least 80 Tgas (wallet helper uses 200). Reads are public, as is ordinary NEAR state; no privacy claim.

| Added method | Arguments / semantics |
|---|---|
| `place_strategy_order` | `strategy_id, is_long, size, limit_price, nonce, expiry_ts, leverage, reduce_only, post_only, immediate_or_cancel`; owner only, 1 yocto; fixed recorded market, shared manual risk/matching rules and per-book nonce |
| `cancel_strategy_order` | `strategy_id, nonce`; owner only, 1 yocto; same-book escrow refund |
| `close_strategy_position` | `strategy_id, position_id, amount? (null = full), min_price, max_price`; owner only, 1 yocto, attributed side and fresh bounded oracle price |
| `strategy_orders` | `strategy_id`; bounded history plus open orders |
| `strategy_positions` | `strategy_id`; independently attributed funded position views |
| `strategy_accounting` | `strategy_id`; free/escrow/stored margin/effective margin/pending and totals |

Prices use contract **1e18 USD/base**, sizes and collateral **1e6**. Owner token deposit remains `ft_transfer_call({receiver_id: configured_exchange, amount, msg: "strategy:<canonical-decimal-id>"})`. No whitespace, signs or leading zeros in the ID. These are ABI examples, not deployed addresses.

`client/lib/near/strategy.ts` exposes owner-wallet custody/place/cancel/bounded-close helpers. It does not give Guardian a signer or add unsigned HTTP mutations. Manual account histories/positions exclude strategy books; global trade/funding records retain explicit attribution.

## PAPER execution / remaining gates

`packages/adapters/`, `packages/risk/`, `packages/vault/` and `services/guardian/` implement local independently persisted PAPER legs, policy, conservative sizing, idempotent reconciliation, monitoring, surplus reduction, owner stop/bounded unwind and deterministic audit replay. Run `cd client && npm run vault:paper` or `npm run test:phase2`. Details and limitations are in `PHASE2_ASSURANCE.md`.

Real strategy custody withdrawal remains an explicit wallet action after funds are settled/unencumbered. PAPER cash is not redeemable collateral. Guardian rejects genuine/mixed execution and has no withdrawal, owner/payout/policy-change authority. Full-access exchange upgrade keys remain a custody trust risk, not restricted executor keys.

Not implemented/approved: genuine two-leg execution, contract-enforced delegated policy authority, a live spot venue, public deployment, continuously scheduled automation, integrated Autopilot UI/API, or production/security certification. V8/S1–S3/D1 and separate real-funds approval remain mandatory.
