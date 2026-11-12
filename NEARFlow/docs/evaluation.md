# Funding evaluation policy and calibration

Status: **F3 sampling/hysteresis review and the specified local MODEL_PAPER market/vault feedback calibration are complete**. Both controller-only and feedback results/replay commands are below. No robust replacement profile passed the feedback study; retain the existing experimental defaults. This is not production calibration, an independent security audit, runtime Guardian verification or a finding of market improvement. Broader S0–S3 product/runtime gates remain open.

## F3 reviewed decision: retain v1 soft deadband for the experiment

Review scope: implementation-agent code/model review, not independent audit. Keep the existing continuous soft dead zone, observation-based EMA and bounded rate memory. Do **not** add a separate enter/exit hysteresis switch: it adds state, threshold choices and sign-reversal semantics without a demonstrated need in this experiment. The completed deadband/EMA/smoothing interaction study did not establish a uniformly better replacement. This is a minimal experimental reference and a negative calibration result, not a claim that it dominates every possible stateful hysteresis design.

- Premium is measured from the latest retained opening fill against the independent index. Positive prices, timestamp bounds and absolute divergence limits constrain the input; no book pressure or matched-OI imbalance is inferred.
- The estimator is bounded but not manipulation-resistant. A tiny/coordinated last fill can dominate the observation. No volume-weighted, median or time-weighted estimator is silently introduced. Such a change needs a reviewed sample window, minimum independent liquidity, bounded storage/gas and adversarial comparison.
- One observation per current UTC-hour epoch. No replay, intra-hour stepping or backfilled samples. Near-boundary bursts can change the last eligible fill; they cannot force extra controller applications. Repeating the same retained fill across eligible epochs is allowed while it remains fresh; this is not independent evidence.
- Missed epochs do not decay EMA or synthesize premium observations. A valid resumed observation blends with existing memory. A missing/stale/future/divergent mark on an eligible update clears EMA and sets zero fallback. A stale oracle rejects the update instead. Neither case rewrites old settlement history.
- Rate expiry does not itself clear stored EMA or quote. It only stops accrual. A fresh oracle tick can resume a still-live quote after an oracle gap, but never charge for the gap; after hourly quote expiry, a new eligible funding application is required.
- Baseline shares signal validation/EMA but has no adaptive slope cap. Zero fallback and owner reconfiguration bypass the normal adaptive slope cap for safety.

### Quantization is part of the policy

Integer truncation preserves caps and signed symmetry, but EMA/rate smoothing need not converge exactly to zero. For example, at default smoothing a previous rate of 4 ppm with zero target stays 4 ppm; at minimum accepted smoothing/EMA coefficients, even larger memory can remain fixed. A rate can also retain its old sign during reversal. A deadband is not a guarantee of immediate zero funding or correct economic sign on every observation. For this versioned experiment the engineering residual tolerance is <=4 ppm at zero target under default smoothing (0.04 bps/hour); that is not zero funding or an approved financial policy. Joint-grid tests verify the integer residual bound `(1e6 - 1) / smoothing`. Any minimum-step/forced-zero fix would change the equations and shared vectors and needs separate review; no such change is made here.

## Deterministic evidence

`packages/funding/traces.json` is consumed by Rust and TypeScript, including sign-mirrored runs. It records expected EMA and rate sequences for alternating sub-deadband noise, persistent premium/reversal, deadband boundaries with fast coefficients, minimum coefficient/cap quantization, default quantization floor and baseline memory. Each step checks exact results and absolute/adaptive slope caps. These are controller traces, **not** market simulations or calibration results.

Existing exchange tests separately cover missing/evicted/stale/future marks, missed epochs, oracle and rate expiry, and epoch replay. Sandbox runs actual keeper CLI processes before/after a bounded oracle outage, checks same-hour restart without reapplying funding, skips stale inputs, then verifies that refreshing the oracle cannot backfill the stale gap. Multi-hour outages remain contract-unit evidence, not a multi-hour keeper-process integration claim.

## Completed controller-only calibration v1

Replay from `NEARFlow/client/`:

```sh
npm run funding:calibrate
npm test
cargo test --locked --manifest-path ../packages/funding/Cargo.toml
```

Artifacts: [summary](calibration/summary.md), [full JSON report](calibration/report.json), [CSV aggregates](calibration/results.csv). The CLI regenerates these and `packages/funding/calibration-vectors.json`; Rust and TypeScript both verify the generated selected-profile traces. Tests also check source/input hashes, JSON/CSV agreement, deterministic metrics, hand-computed traces, signed symmetry, quantization and holdout rejection. Rerunning with unchanged source/revision/dirty state produces byte-identical artifacts.

- **216 joint profiles:** cap {1000, 2000}, step {100, 400}, deadband {0, 200, 500}, EMA alpha {250000, 500000, 1000000}, smoothing {200000, 500000, 1000000}, nonlinear scale {1000, 10000}; other bounds/TTLs unchanged. Includes the existing default. This is a predefined grid, not exhaustive parameter-space verification.
- **Eight exogenous scenarios:** noise, persistence, reversal, spike, sparse/missing fill, exact-hour-boundary/intra-hour bursts, oracle outage, and out-of-bound/future-mark manipulation. Each uses 32 hours, both signs, training seeds {7, 41, 2026} and held-out seeds {101, 503, 9001}. Baseline/adaptive receive byte-identical observations. No trader-response model or synthetic market-impact advantage is assumed.
- **Selection rule:** among adaptive training profiles, require noise mean absolute rate <=100 ppm, longest wrong-sign run <=5 consecutive valid samples and normal update step <=400 ppm. Minimize mean absolute tracking error against raw premium clamped to 2000 ppm; break ties by total variation then profile ID. The holdout only accepts/rejects that training winner—no holdout retuning. These are explicit engineering budgets, not owner-approved financial policy. Gaps/fallback interrupt wrong-sign runs; this is not a duration/exposure metric. Emergency fallback/expiry jumps are included in variation but exempt from the normal-update slope budget.
- **Bias/limits:** tracking a raw-premium target favors higher caps/less smoothing by construction and does not determine economically optimal funding. Prices are exogenous, so premium reversion is not measured. No spot/perp adapter, vault feedback, custody ledger, fees, margin/liquidation, delta or net P&L is simulated. Missing economic metrics are not fabricated as zeros.

### Result and decision

The accepted offline profile is **c177**: cap 2000, step 400, deadband 0, EMA alpha 1000000, smoothing 500000, nonlinear scale 1000 (all ppm where applicable); TTL/divergence/schema values remain at defaults.

On held-out inputs, default adaptive mean tracking error is **618.950 ppm** versus **512.775 ppm** for c177. But total rate variation increases **207900 → 238608 ppm**, and mean noise funding rises **0 → 59.927 absolute ppm**. Wrong-sign valid samples fall **174 → 104**; the longest run remains four samples. Default baseline tracking error is **77.316 ppm** and c177 baseline is **0**—adaptive does not beat baseline tracking under this deliberately simple proxy. Full per-scenario/seed/sign comparisons, including adverse outcomes, are retained in the report.

**Decision:** retain the current contract defaults and equations as the reference checkpoint; publish c177 only as an experimental sensitivity profile. Do not deploy it or describe it as more profitable/market-stabilizing. Its lower tracking error does not compensate for noisier funding under an approved economic objective because no such objective has been validated. The subsequent feedback study below rejects adopting c177 under its stricter cross-scenario rule; c177's zero deadband is not silently adopted.

## Completed market / PAPER-vault feedback calibration v1

Replay from `NEARFlow/client/`: `npm run funding:feedback`, then `npm test`. Results: [summary](calibration/feedback/summary.md), [versioned model/review scope](calibration/feedback/MODEL.md), [full provenance/parameters/aggregates/rejection reasons](calibration/feedback/report.json), [every run CSV](calibration/feedback/runs.csv), [decision/failure traces](calibration/feedback/traces.json).

- **30,240 runs:** 15 joint profiles (defaults, c177, EMA/smoothing/deadband interactions and lower cap/slope variants), 14 scenarios, three training seeds {17,29,61} and fresh held-out seeds {701,911,1409}, both demand signs, zero/weak/strong trader response and baseline/adaptive × vault off/on. Inputs are byte-identical across compared arms. These held-out seeds were not used to select c177 in the earlier study.
- **Endogenous response:** only executed matched lots move the synthetic book; funding-responsive aggressor flow and two policy-bounded PAPER long-spot/short-perp strategies compete for finite depth. No aggregate matched-OI skew is used. Expensive/negative expected carry, stale input, exhausted budgets and unavailable venues decline entry. One decision per strategy/hour prevents recursive rate chasing.
- **Economics/accounting:** independent finite spot inventory/cash and perp free collateral/margins; exact integer funding/remainder, payer caps, bilateral capped P&L, partial close and liquidation penalty/reward; actual modeled entry/exit/repair costs. Both ledgers conserve at 997,920 dual-ledger checkpoints. Realized and marked unrealized net P&L reconcile. Shared vectors validate the PAPER settlement/payout against authoritative Rust math; the constant-price oracle-checkpoint reduction is tested against individual updates and hand-computed expiry amounts.
- **Failures and metrics:** impulse/reversion, noise, persistent/reversing pressure, crashes/rallies, sparse fills, low depth, oracle/keeper gaps, spot outage, partial/pending second leg, unrelated counterparty close, tiny manipulated last fill and fill bursts. Report premium mean/peak/reversion (including censored probes), funding peaks/variation/sign flips, margin/liquidations/caps, drawdown, funding, costs, net P&L, delta size/base-hours, pending fills, repair costs, pause/skip decisions and terminal inventory. A capped perp gain need not hedge the spot crash; an unavailable spot venue can leave residual inventory after bounded retries stop.
- **Selection:** require no per-case training regression against fixed default BASELINE in premium/peak, vault P&L, drawdown, costs, residual exposure, liquidations or funding variation, with at least some strict premium improvement. The holdout only accepts/rejects the training winner; incomplete/duplicate cases fail checks. All scenarios are equally weighted stress experiments, **not** probabilities or a return forecast. The strict joint-dominance filter is a research decision rule, not a universal economic requirement.

### Result: no robust replacement; retain defaults

No training profile passed that rule, hence **no profile is approved for adoption**. Held-out results remain published, including counterexamples: without trader response or vault flow, controller choice cannot change the modeled book; with weak/strong response, default adaptive can leave a larger premium than baseline. c177's better controller tracking did not translate into uniform market/vault improvement. The suite's stress-weighted vault P&L averages can be negative. This is a completed negative experiment, not a missing-result placeholder.

The sampling review retains one fresh bounded opening-fill observation per current epoch, no backfill or fabricated samples, and observation-based EMA with explicit zero fallback. It accepts the last-fill estimator **only as the bounded experimental reference**: a tiny eligible fill can still manipulate it; parameter tuning cannot establish manipulation resistance. No new estimator/book input, contract parameter, configuration revision, trading permission or deployment is activated.

## Remaining release/runtime boundaries (not missing F3 model calibration)

- Independent F4 accounting/security review, full accepted extrema, storage/fresh-deployment rehearsal and external oracle/last-fill manipulation assessment remain release blockers.
- V0–V8/C0–C2 must still implement and test the actual strategy reservations, PAPER/live adapters, owner policy, receipt reconciliation and Guardian. The research policy/ledger is not that implementation and cannot spend chain assets.
- Broader S0–S3 runtime integrations, empirically fitted depth/impact/response/costs, sub-hour execution/finality/queue dynamics, multiple-market mark retention and out-of-distribution validation remain unverified. The hourly matched-lot model makes none of those claims.
- Any future change to defaults requires fresh evidence against the actual implemented loop, reviewed configuration revision/history and separate activation approval. F3's local completion does not close F4 or authorize real execution.
