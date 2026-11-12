# Phase 3 — finalized funding → bounded PAPER execution

## Scope

C0–C2 now have a local PAPER coordinator in `services/guardian/funding-loop.ts`. It consumes the existing contract's atomic finalized funding view; it cannot publish prices, configure/update funding, sign orders or move real collateral. Actual order/fill reconciliation remains the Phase 2 Guardian's job. This is prerequisite implementation/testing, **not permission to activate V8 or deploy**.

There are three distinct source labels: `LOCAL_FIXTURE` (synthetic deterministic test inputs), `LOCAL_SANDBOX` (actual local finalized JSON-RPC) and `NEAR_TESTNET` (read-only public network configuration). Both execution legs remain `PAPER` regardless of source label. A public funding read does not make a virtual spot/perp strategy a live vault.

## Data and authority boundaries

- `funding-source.ts` queries only `funding_snapshot`, with `finality: "final"`. It requires an explicit `.testnet` account, HTTPS for public RPC or loopback HTTP for Sandbox, rejects embedded URL credentials, applies a 15-second timeout and bounds the response while streaming. No key loader, transaction method or keeper authority is imported.
- Snapshot/envelope validation covers network, scope/contract, block height/hash, market count/identity, canonical integer price/OI fields, controller mode/revision/epoch/rate bounds and configured oracle TTL. The existing `client/lib/near/funding.ts` computes effective rate, fallback and exact expiry semantics; legacy rate-only snapshots are not accepted.
- Both chain time and wall time must remain fresh. Network-scope observations recheck wall time **after** RPC rather than carrying the tick's original timestamp across a slow request. Explicit fixture clocks are restricted to `LOCAL_FIXTURE`; the Sandbox integration injects its fast-forwarded chain clock only for `LOCAL_SANDBOX`. `NEAR_TESTNET` ignores that optional clock and always uses wall time.
- Backward finalized heights/timestamps/revisions/epochs, or different hashes/data at one finalized height, stop execution. This trusts the configured RPC's finalized response; it is not an independent light-client proof.
- Per-strategy policy hashes and membership are pinned separately from the immutable group feedback policy. Local configuration/caller confirmation remains trusted infrastructure, not cryptographic wallet authentication or delegated spending authority.

## C0: decisions, execution and observed market state

Each registered strategy gets at most one opportunity decision per funding epoch, including declined decisions. A finalized observation is not an instruction to trade. The loop obtains independent PAPER quotes/balances, sizes conservatively, accounts for capped collectible funding and costs, then durably reserves the group allowance and exact plan **before** calling Guardian or an adapter.

Funding forecasts assume continued oracle publication and a surviving payer over a stated uncertain horizon, bounded by the current rate's one-hour lifetime. They do not treat the current oracle TTL as a promise of future publication. New submissions are nevertheless bound to the current oracle/rate expiry and both quote expiries; the source is reread before every leg. A longer forecast is not permission to use an expired observation.

Pending plans and stable client IDs survive restart. A crash checkpoint between Guardian proposal persistence and loop acknowledgement recognizes the existing proposal rather than proposing another order. Missing receipts remain unknown, not authorization to resubmit. Overlapping workers fail the group worker lock instead of racing a shared depth/flow budget.

The coordinator **never fills orders itself**. Reconciled independent venue events change virtual inventory and executable PAPER depth. `PaperAdapter.quote()` now reports remaining depth for the quote version; partial fills, later orders and external exits share its finite liquidity allowance. `marketView()` reports bounded observed fills. Historical order requests remain immutable for reconciliation.

Market observations explicitly separate PAPER depth/exposure from the actual snapshot's matched OI. No long-minus-short OI signal or fabricated chain impact is introduced. PAPER fills cannot change the real exchange's balances, last fill or OI. Genuine endogenous on-chain feedback is unavailable until V8; the earlier F3 model remains separate research, not proof of a live effect.

## C1: feedback safeguards

`packages/risk/feedback.ts` adds:

- Separate positive entry and lower exit thresholds; **at least two consecutive funding epochs**, unchanged controller revision, before entry. Missed epochs, reversal, fallback or reconfiguration reset persistence; there is no backfill.
- At most **one new market entry per epoch across the whole registered group**, preventing an immediate self-induced entry cascade. Other strategies receive explicit skip reasons. No settled/stopped strategy is automatically restarted.
- Market-wide cooldown, shared epoch/daily gross-flow reservations, shared projected cost allowance and participation/depth caps, in addition to each Guardian's reserve/margin/delta/turnover/cost/retry limits.
- Gross flow reserves three times entry gross up front: entry plus conservative exit/repair allowance. Reduction-only repairs cannot grow inventory or recycle the allowance into a new opening. Reservations are never refunded into a fresh opportunity after a rejected/unknown submission.
- Quotes must match the finalized market identity and stay within 3% of the finalized index. Zero depth, stale/unavailable quotes, unprofitable net carry and insufficient collateral cause a skip, not a funding chase.

These are conservative implementation bounds, not empirically calibrated production limits or a measured market-stabilization claim.

## C2: invalidation and recovery

Controller fallback/revision/mode/index/epoch changes, expired/stalled observations, source outage/conflict, wrong strategy policy, unknown venue state or owner stop invalidate old plans. The loop stops unsent actions, cancels only known pending orders, and reconciles both legs. Unknown or failed cancellation remains visible and alerted. It does not invent an exit price, receipt or successful cancellation.

Unilateral counterparty removal/manual venue reductions are reconciled as external changes. Within owner policy and the already reserved total cost allowance, the Guardian may reduce residual surplus inventory. Otherwise it pauses for investigation/owner exit. Repair never increases a broken hedge. A fully reconciled flat repair now reaches terminal `settled`, rather than calling zero inventory "hedged". This implementation is deliberately one-shot: a new epoch/config/index invalidates the old binding, even for an existing hedge; it stops for owner inspection/exit rather than automatically rolling authority into a new plan. There is no automatic resume/re-entry.

The loop never invokes an owner-only close by pretending to possess a signing key. Real custody release/withdrawal stays an explicit owner-signed contract action; PAPER cash is not redeemable on chain.

## Running and persistence

From `client/`:

```sh
npm run test:loop
npm test
npm run typecheck
npm run test:sandbox
npm run lint
npm run build
```

To integrate a read-only source, construct `finalizedSource(explicitRpc, freshExchangeId, sourceScope)`, a `FundingLoop` with independent initialized PAPER Guardians, and call `initialize(groupPolicy, maximumSizes)` once. Invoke `tick(wallSeconds)` from a trusted local caller; network scopes use current wall time internally. There is deliberately no public API, daemon deployment, wallet mutation route or unattended service installed by this change.

The group journal, Guardian journals and two adapter ledgers must reside in one trusted private directory. The extra `.worker.lock` spans source reads/actions while the ordinary journal transactions persist reservations individually. A crash-held worker lock requires the same stop/inspect/archive/reconcile procedure as Phase 2; never steal a live lock, clear a sent flag or reset an allowance to force liveness. All stores retain bounded history and fail closed on capacity/corruption. Archive before capacity as documented in `PHASE2_ASSURANCE.md`; retain the group journal and all member ledgers together. One canonical group per market/strategy set is required; separate directories do not create a distributed shared budget.

## Verification / limits

- **18 new deterministic loop/source tests**, covering accepted/declined opportunities, observed finite depth and unchanged matched OI; schema/freshness/finality; same-epoch replay and restart checkpoint; competing workers and strategies; shared budgets; gaps/reversals; pre-submit reconfiguration between legs; source outage/stalled/regressed/conflicting snapshots; slow RPC wall-clock expiry; owner stop, unknown receipts and counterparty-close repair.
- Existing **89 TypeScript tests** remain passing (total **107**). The Phase 2 fixtures still pass with remaining-depth quotes and stricter funding expiry before dispatch.
- **All three actual-Wasm Sandbox integrations pass** (the extended exchange/funding integration and the separate vault/deployment integrations). The extended test advances two consecutive chain hours, consumes actual finalized adaptive quotes **400 → 720 ppm**, waits for persistence, submits independently pending PAPER legs and reconciles explicit fixture fills to a hedge. Remaining PAPER depth drops by the filled size; the real owner's available balance and real matched OI remain unchanged. No real hedge order is signed by the loop.
- **111 exchange + 4 funding Rust tests**, both existing Chromium funding fixtures, lint, combined client/backend typecheck and production build pass. `npm run vault:paper` still passes the earlier Phase 2 standalone fixture.

### Sandbox harness failure dispositions

The initial extended runs exposed test-infrastructure issues, not successful evidence: fast-forward takes **blocks**, not seconds (~0.3s/block here); large jumps left finalized headers >10s behind current chain time, so using them as a new oracle ingress timestamp correctly rejected. The test publisher now obtains current optimistic chain **time only**, while the loop still reads finalized atomic funding state. No production freshness rule was relaxed.

A long run also filled near-sandbox 0.3.5's unread stderr socket and blocked its tracing thread on shutdown. The pinned-version test harness now drains that child stderr stream; contract receipt logs/assertions are still retained. A fresh unassisted rerun completed successfully in ~239 seconds, including normal teardown. The 300-second test budget accommodates two actual chain-hour advances; this is not a fast unit test. Earlier timed-out/interrupted attempts are not counted as passing runs. Recheck this private child-process workaround when upgrading `near-sandbox`.

Not verified/authorized: genuine spot execution, signed autonomous two-leg NEAR execution, public deployment or wallet flows, unattended scheduling, multi-host coordination, independent security audit, empirically fitted feedback parameters or full S0–S3 integration. V8/D1 and operator spending/publication remain separately gated.
