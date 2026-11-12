# Feedback model v1 — scope and sampling/hysteresis review

## Evidence boundary

This is an internal **MODEL_PAPER** experiment under `packages/sim/`, not the exchange, a connected venue, a live vault, the runtime Guardian, or independent review. It does not import wallet/signing/RPC code, credit real custody, deploy or activate configuration. The implementation agent reviewed the accounting and sampling paths; independent review remains F4/S3 work.

Research conclusion: no candidate met the predefined cross-case no-regression rule. Retain the existing experimental defaults; do not adopt the controller-only c177 winner. This is completion of the stated local calibration with a negative outcome, not production/empirical validation.

## Fixed-point ledgers

- Prices: 1e18; base and quote atoms: 1e6. Notional truncates; opening margin is ceiling(notional/10), entry fee is ceiling(notional × 3/10000). Each matched lot has an actual long and short with separate collateral; OI is equal by construction, not a funding signal. Fills respect the 5% oracle band, one-quote-unit minimum, position/OI capacity and available collateral.
- The global funding index follows the contract's price × rate × elapsed / (1e6 × 3600), truncating each checkpoint, capped by oracle TTL and quote lifetime. Pair settlement carries signed remainders and caps transfers by payer collateral. P&L is capped by bilateral margins. Partial close prorates margins/remainder. Liquidation uses 500 bps maintenance, capped 50 bps penalty and half reward to the keeper.
- Opening fees and liquidation penalties go to explicitly accounted insurance/reward balances, never an assumed bailout. Every event frame and terminal view audits free cash + margins + insurance against funded PAPER custody and verifies zero-sum funding.
- Spot inventory and cash are a separate finite custody ledger, with a venue counterparty. Both transfers are conserved. Buys include modeled fee/slippage in cost basis; sells realize proceeds minus that basis. P&L does not subtract fees twice or credit spot assets into perp collateral. Shared JSON cases compare signed settlement, dust, payer exhaustion and capped payout against Rust contract functions.

## Timeline and fill model

There are 32 hourly frames. Exogenous index price is constant inside a frame. Healthy oracle publishers checkpoint every 30 seconds; an exact algebraic reduction of equal-price checkpoint truncations replaces 119 identical updates. Tests compare it with individual updates, both signs and expiry. Oracle/keeper outages stop rate accrual on the real TTL/lifetime rules; refresh never backfills a gap.

At each boundary: accrue the old index, publish a healthy index, settle/check old pairs when oracle-valid, process counterparty exits/liquidations, accept organic matched lots, sample the latest retained opening fill, apply at most one funding update, execute bounded funding-responsive flow, then evaluate each PAPER vault. Executed flows alone change subsequent book pressure. The organic-fill sequence, exogenous prices, depth and availability are common across all compared arms. Closing uses the independent oracle as the contract does, not the last fill.

This is a matched-lot/depth model, **not** a resting order queue or full exchange emulator. The book premium has 0.8 hourly retention and 2000 ppm impact per full depth; responsive aggressor size is rate × assumed response × depth / 1000, capped at half remaining depth. Response assumptions are 0, 0.1 and 1.0; they are not fitted from real traders. Two vaults share remaining depth. Under zero response and vault-off, changing funding cannot improve this synthetic book; tests enforce the control.

Policy/risk checks are hourly; intra-frame receipt latency, queue priority, order cancellations and sub-hour delta durations are not represented. Reported `maxDelta` includes the transient sequential spot-first leg; `maxDeltaAfterStep` and base-hours describe unresolved end-of-frame exposure, not continuous-time guarantees. Reversion probes measure hours to <=500 ppm book deviation after impulse/flow removal; non-reversion at the horizon is explicitly censored.

## PAPER hedge assumptions

Each of two isolated strategies begins with 5000 quote units of perp cash and 5000 of spot cash. Only long-spot/short-perp carry is supported; negative funding correctly produces skips/unwinds, not a fabricated reverse hedge. Other participants and the spot venue have separately funded finite balances.

The fixed policy requires two observations of >=1000 ppm funding, two-hour cooldown, eight-hour uncertain carry horizon/maximum hold, 500 quote gross cap, 200 quote perp reserve, 2000 quote daily turnover, two quote daily cost budget and two repair attempts. Entries must cover both spot legs' assumed 20 bps fee/slippage, perp entry fee, a 30 bps exit/repair/adverse-basis reserve and four fixed action costs. Collectible funding is bounded by the proposed payer margin. Each successful modeled vault action pays a fixed 0.01 quote cost into an operator balance; this is not measured NEAR gas. Oracle/keeper infrastructure costs are not charged to vault P&L.

Spot and perp fills are independent. A partial second leg creates a one-hour pending/reconciliation window with no blind resubmission, then bounded reduction/repair or pause. Venue outages can prevent repair; exhausted retries retain visible inventory instead of assuming a miraculous exit. Counterparty close or liquidation removes a perp leg independently. A capped gain can break economic hedge effectiveness even at zero base delta. No owner withdrawal, strategy trade delegation or unrestricted executor is implemented by the model.

The policy is versioned research configuration, not a reviewed owner policy, contract-enforced permission scheme or V0–V8 implementation. Terminal inventory is valued and disclosed, not counted as settled withdrawable earnings. Scenario-average P&L uses equal stress-case weights and is not an expected return.

## Sampling/hysteresis review decision

1. Retain the contract's **bounded latest opening fill** against the independently published index, including configured TTL/divergence checks and missing/evicted-mark zero fallback. A tiny eligible matched fill can still dominate it. The manipulation scenario exercises an approximately two-quote-unit fill at a 4.9% premium; it does not demonstrate manipulation resistance. No unreviewed volume/book-pressure estimator is added to the contract.
2. Retain exactly one current-hour observation, no backfill or fabricated time-decay. Valid resumed observations blend with existing EMA. Invalid mark fallback clears EMA; stale oracle rejects instead. Fill bursts cannot step the controller repeatedly. Existing contract replay tests complement the model's single-update scheduler.
3. Retain the **continuous soft deadband + EMA/rate memory**, not a new Schmitt trigger. The two-stage joint sensitivity study finds no uniformly better replacement under the stated filter; adding enter/exit thresholds without evidence would add unreviewed state. This is not a proof that stateful hysteresis cannot be useful.
4. Accept <=4 ppm default zero-target integer residual as the explicit local engineering tolerance, not zero economic funding. Keep quote expiry and collateral caps. Forced-zero/minimum-step changes are not silently introduced.
5. Keep defaults, storage, controller revision and permissions unchanged. A future parameter/estimator change needs a new experiment version, source/input provenance, actual implemented-loop replay, independent review and separate activation approval.

## What this closes—and does not

This closes F3's defined local sampling/hysteresis review and MODEL_PAPER market/vault calibration. The full report contains all 30,240 runs, 5,040 scenario aggregates, fresh training/holdout seeds, source hashes/revision/dirty state, paired input hashes, policy/assumptions, rejected settings and failure traces. Tests round-trip every CSV field/JSON aggregate and replay selected traces.

It does not close F4's independent security/storage/extrema gate, actual strategy/adapter/Guardian tasks V0–V8/C0–C2, broader S0–S3 product integration, browser/public verification or empirical external-liquidity calibration. No funded state or contract code was modified for this experiment; the only contract change is an additional accounting-vector test.
