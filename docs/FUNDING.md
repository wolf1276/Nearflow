# Reflex Perps funding controller v1

Experimental test-fund implementation; no demonstrated live-market advantage. The existing matched, isolated bilateral exchange remains the only balance/position ledger.

## Signal adapter and hypothesis

`update_funding` constructs its signal from the market's independently published index and the latest retained **opening fill** for that market. Callers cannot supply a mark, premium or rate. `packages/funding::premium` validates both prices and timestamps: positive prices <= 1e27, no future observations, index age <= configured oracle age, mark age <= configured mark age, absolute premium <= configured bound. The bounded global trade ring may evict a market's last fill; that is treated as missing data, not reconstructed history.

This is MATCHED_ORDERBOOK: long and short OI are equal by construction. There is no OI-skew or LP-capacity input. The hypothesis is that a superlinear premium response with smoothing and a rate-change limit might reduce persistent mark/index dislocation. It may also lag reversals or perform worse. Last fills can be manipulated by coordinated accounts; freshness and divergence limits bound but do not eliminate this risk. The independent index still trusts the authorized oracle publisher; source aggregation is not verified by the contract.

## Units, parameters and equations

Prices and the cumulative index are USD/base scaled 1e18; base size and collateral use the existing six-decimal integer convention. Premiums, EMA, rates and coefficients use **1e6** scale: 100 ppm = 1 bp. Rates are per **3,600-second interval**, not APR. Positive means longs pay shorts. All signed divisions truncate toward zero in Rust and TypeScript.

Parameters are schema `version: 1`; unknown versions are rejected. Per-market `revision` starts at 1, increases on configuration, and is emitted with the complete configuration. Defaults and enforced ranges:

| Field | Default | Allowed |
| --- | ---: | --- |
| cap_ppm | 2000 (20 bps/hour) | 1..2000 |
| step_ppm | 400 (4 bps/update) | 1..cap |
| deadband_ppm | 200 (2 bps) | 0..2000, strictly below max premium |
| smoothing_ppm | 200000 (20%) | 1..1000000 |
| ema_alpha_ppm | 500000 (50%) | 1..1000000 |
| nonlinear_scale_ppm | 10000 | 1000..100000 |
| max_premium_ppm | 100000 (10%) | 2000..100000 |
| oracle_max_age_sec | 60 | 1..60 |
| mark_max_age_sec | 300 | 1..300 |

At each successful current-hour update:

```text
sample = (mark - index) * 1e6 / index
p = first sample, otherwise previous_ema + (sample - previous_ema) * ema_alpha / 1e6
BASELINE = clamp(p, -cap, cap)
q = sign(p) * max(abs(p) - deadband, 0)
target = clamp(q + q * abs(q) / nonlinear_scale, -cap, cap)
smoothed = previous_rate + (target - previous_rate) * smoothing / 1e6
ADAPTIVE = clamp(clamp(smoothed, previous_rate - step, previous_rate + step), -cap, cap)
```

The deadband is continuous before integer quantization: `q` and the nonlinear term approach zero from either boundary. It is a soft dead zone, **not** a discontinuous Schmitt-trigger hysteresis switch. EMA/rate smoothing provide temporal memory. EMA is observation-based, not a wall-clock half-life: missed epochs are not synthesized; a valid observation after a gap blends with the last EMA. Both algorithms use the same EMA and signal validation; only adaptive uses deadband/nonlinearity/rate smoothing/slope limiting. Baseline has an absolute cap but deliberately no slope cap.

## Cadence, fallback and settlement

- `publish_price` accrues the previous price/rate index before replacing the index observation. It never changes the controller rate or EMA.
- Anyone may call `update_funding(market_id, epoch)` with one yoctoNEAR. `epoch` is a decimal-string U64 equal to current chain seconds / 3600, strictly greater than the last applied epoch. No historical replay/backfill. Oracle ticks and lazy pair settlement cannot trigger extra controller steps.
- A stale oracle rejects updates, risk-increasing execution and unsafe closes/liquidation. Previously accrued funding remains owed. Accrual stops at the earlier of oracle expiry and 3600 seconds after rate application, even if the oracle publisher continues while the keeper is down.
- Missing, stale, future or divergent marks produce an explicit **zero-rate fallback** and clear EMA at the next eligible update. They never substitute the fill for the independent index. This neutral fallback permits opening trades to establish a valid mark; it is not an oracle-validity override. Emergency/configuration zeroing is intentionally exempt from the normal adaptive slope limit.
- Owner-only `configure_funding(market_id, mode, params, expected_revision)` requires one yoctoNEAR, validates parameters and revision, accrues the OLD index, resets rate/EMA to zero/empty, consumes the current epoch and logs the new configuration. Accrued history and pair checkpoints are never rewritten. The new mode starts no earlier than the next epoch. Configuration cannot repeatedly initialize an adaptive rate within an hour.
- The existing pair checkpoint/remainder accounting is unchanged. Settlement transfers exactly the same integer amount out of one margin and into the other, capped by payer collateral. Repeated settlement at the same index does nothing. Fractional pair remainders survive repeated settlement and normalize on sign reversal; collateral exhaustion clears uncollectible remainder. No pool, phantom receivable or new balance ledger is introduced.
- Price/index checkpoints truncate <1 unit of 1e-18 USD/base per checkpoint. This can slightly underaccrue funding but does not mint money or cause unequal transfers; pair-level fractional payment dust remains tracked. No promise of partition-independent market index precision is made.

`get_market` / `get_markets` expose `controller`, `funding_rate_ppm`, and estimated current `funding_index`. `funding_rate_bps` remains a truncated legacy display field only. A stored rate is the last applied hourly quote, not a guarantee it is still accruing during an outage. The keeper applies current epochs before lazy pair settlement.

### F2 local hardening checkpoint

Execution, match proposals, account-health staleness and liquidation discovery share the same contract freshness predicate: positive price, nonfuture timestamp, age **<= configured oracle TTL**. API readiness and keeper update/settlement checks mirror it. The contract status field `oracle_max_age_seconds` is the legacy/default maximum (60), not a replacement for each market's configured TTL.

`funding_snapshot()` returns chain seconds, status and projected markets in one view execution, without changing storage or accrued history. Readiness and market list/detail funding projections use this finalized snapshot instead of separate status/market calls; missing support fails closed (503), never silently falls back to mixed snapshots. Existing deployed binaries must not be assumed to support this method.

Market list/detail APIs retain raw contract quote fields and additionally expose `stored_funding_rate_ppm`, `effective_funding_rate_ppm`, `funding_expires_at`, `funding_inactive_reason`, `funding_as_of` (snapshot chain seconds) and fractional `funding_rate` (effective ppm / 1e6). Accrual has no remaining duration at the exact expiry second, although the oracle is still execution-valid at its inclusive TTL boundary. Reasons distinguish `ORACLE_STALE` (including future/zero price), `RATE_UNAVAILABLE` (missing/future application metadata), `RATE_EXPIRED` and `ZERO_FALLBACK`. Legacy markets without controller metadata retain the 60-second oracle rule but project zero effective funding rather than infer an unbounded rate lifetime. These projections never authorize transactions or rewrite accrued funding.

Readiness requires oracle validity at both snapshot time and integer server wall-clock seconds. Funding projections likewise fail closed on either freshness check and expire at the later clock. Server skew can therefore suppress readiness/accrual displays, but cannot revive expired funding or accept inputs that were future at snapshot time. A stalled finalized block cannot stay ready just because its own clock stopped. Status/controller/market inputs are atomic; separate trade-history requests are not part of that snapshot. The server clock and configured RPC remain trust assumptions; a projection cannot authorize on-chain risk.

Verified locally: 91 exchange Rust tests, 4 funding Rust tests, 64 TypeScript tests, lint/typecheck/build and both actual-Wasm Sandbox regressions. Cases cover shorter TTL, exact boundaries, risk/proposal consistency, future inputs, evicted marks, fresh-oracle/expired-rate separation, clock disagreement, stalled snapshots and same-revision projection. Sandbox exercises the new view through finalized JSON-RPC readiness. Keeper now reads the same atomic snapshot; script-runtime views explicitly request finalized state. Sandbox launches four independent actual keeper CLI processes using a temporary, mode-0600 local Sandbox credential, removed in `finally`. It verifies no same-hour reapplication, stale-oracle skip, fresh-oracle recovery without stale-gap accrual and custody conservation. This is a bounded oracle-outage/process-restart test; multi-hour missed epochs remain contract-unit evidence. Browser expiry/disclosure checks remain open. F2 is not an end-to-end completion claim; F3 MODEL_PAPER calibration is now completed below, while later public release gates remain separate from the completed, user-approved F4 implementation-agent review.

### F3 sampling/hysteresis review and local feedback calibration complete

[Evaluation policy and results](evaluation.md) retain the current soft-deadband/last-fill/observation-based EMA reference, with explicit manipulation, sparse-market and quantization limitations. A completed synthetic sweep evaluates 216 joint profiles, eight exogenous scenarios, three training and three held-out seeds, both signs and both modes. [Artifacts](calibration/summary.md) include all candidate metrics, source/revision/dirty-state and input hashes, exact CSV aggregates and adverse outcomes. `npm run funding:calibrate` in `client/` replays the experiment.

Offline c177 (cap 2000, step 400, deadband 0, EMA 1000000, smoothing 500000, nonlinear scale 1000) reduces held-out mean tracking error from 618.950 to 512.775 ppm relative to default adaptive, but increases variation from 207900 to 238608 ppm and noise funding from 0 to 59.927 absolute ppm. This engineering proxy does not establish economic optimality; baseline tracks better and no market/vault response or profitability is simulated. **Defaults and on-chain equations remain unchanged.** The subsequent endogenous MODEL_PAPER feedback study below provides the F3 local research decision; this earlier tracking winner is not an activation recommendation.

Original stateful traces and generated `calibration-vectors.json` are checked exactly by Rust and bigint TypeScript, including sign mirrors. For example, default smoothing can leave a 4 ppm rate unchanged at zero target; minimum coefficients can preserve much larger memory. The F3 review explicitly retains <=4 ppm as the default zero-target engineering residual tolerance, not zero economic funding. Tests document this rather than silently changing the equations.

The completed [feedback calibration](calibration/feedback/summary.md) runs **30,240** cases over 15 joint profiles, 14 scenarios, three training and three fresh held-out seeds, both demand signs, zero/weak/strong trader response and baseline/adaptive × vault off/on. An internal matched-lot model adds funding-responsive executed flow and two policy-bounded long-spot/short-perp PAPER strategies. It uses finite independent spot/perp custody, contract-compatible capped integer settlement, actual modeled costs, partial legs, pauses and unresolved inventory. All 997,920 dual-ledger frame/terminal checkpoints conserve; accounting vectors are shared with authoritative Rust math. Premium/reversion, rates, margin/liquidation, drawdown, funding/cost/P&L, delta, repairs and negative outcomes are exported with source/input hashes and exact CSV/JSON/trace replay.

**Decision: no replacement passed the predefined no-regression filter. Retain defaults and the continuous soft deadband/observation-based EMA/latest bounded opening-fill reference.** A tiny retained fill remains manipulable; the study does not prove a robust estimator or show that an untested stateful hysteresis switch is better. It reproduces capped-perp crash losses and failed-venue residual spot exposure instead of hiding them. [Model/review assumptions](calibration/feedback/MODEL.md) distinguish this completed local F3 experiment from actual strategy/adapter/Guardian implementation, independently reviewed release readiness and empirical live-market validation. None of those later gates or real execution permissions are implied.

### F4 settlement assurance complete for approved local review scope

A deterministic seed drives 64 cases × 200 signed funding-index steps (12,800 total), comparing U256-based settlement against an independent i128 numerator/division reference within explicitly safe test bounds. Sizes include one base atom and 1e9 atoms; payer margins include one collateral atom and 1e12 atoms. Every step checks capped payment/remainder equality, zero-sum margin conservation, remainder bounds and same-index idempotence. This extends local arithmetic evidence, not an audit. Follow-up adds 32 actual-contract configuration/matching cycles with 128 epoch/settlement/partial-or-full-close steps, independent integer settlement expectations, exact TTL boundaries, configuration-history freezing and repeated-settlement idempotence. A separate 512-corner parameter sweep verifies EMA/rate signed symmetry and baseline/adaptive caps. Legacy pre-controller Market bytes from revision 01cc71a fail current decoding, while current bytes round-trip. Subsequent assurance adds 90 price/size/margin/rate boundary combinations with both exit-price extremes, actual unfundable/minimum-notional order rejection, funded root-state round-trip and legacy-root rejection. The user approved replacing independent F4 sign-off with documented implementation-agent review; [F4_REVIEW.md](F4_REVIEW.md) records its completion, content hashes, findings and retained limitations. Three final tests explicitly verify signed checkpoint-truncation bounds, partial-close subatom funding dust and duplicate full-close rejection. Current rerun evidence is 98 exchange Rust, 4 funding Rust and 65 TS tests, 3 Sandbox integrations, 2 Chromium fixtures and passing lint/typecheck/build. No independent audit or archived-state migration certification is claimed.

Deployment preflights now require distinct exchange/oracle/token accounts, a finalized zero-code account and empty contract data at that exact block. No status/metadata RPC failure is treated as fresh-account approval. Providing a token key means fresh token deployment; omit it for an existing token. Existing/uninitialized code, storage left after code removal, RPC failure, malformed data and cross-block state all reject. Sandbox rehearses the same guard on actual fresh accounts before Wasm deployment and rejects those accounts once code exists, before initialization. The subsequent actual deployment-CLI Sandbox rehearsal also verifies fresh initialization, funded-state refusal without storage changes, interrupted-code refusal and replacement recovery while retaining original custody. Every deployment write awaits FINAL receipts before dependent reads. This is local evidence only, not approval to deploy publicly or spend operator funds.

## Deployment compatibility — mandatory fresh deployment

**Market and root Exchange Borsh storage layouts changed (funding metadata and real strategy custody). Do not upgrade an initialized old exchange in place.** There is no migration entrypoint. Pause risk on the old deployment, settle/close using its original code and withdraw all user collateral, then provision a new contract account, initialize markets, register storage and explicitly deposit test tokens there. Never delete or reinitialize funded state. The deployment script already refuses initialized accounts. Pair and account accounting schemas were preserved, but that does not make market bytes compatible.

No public testnet deployment or wallet verification was performed for this phase. Sandbox receipts are local evidence only.

## Reproduce

From `NEARFlow/`:

```sh
cargo test --locked --manifest-path packages/funding/Cargo.toml
cargo test --locked --manifest-path contracts/exchange/Cargo.toml
cd client
npm run funding:calibrate     # controller-only synthetic sweep; regenerates research artifacts/vectors
npm run funding:feedback      # endogenous market/PAPER-vault ablations; no chain access
npm test                     # regressions, shared Rust/TS vectors, calibration/provenance/CSV checks
npm run test:sandbox          # real local Wasm funding/replay/authorization/settlement receipts
npm run lint
npm run typecheck
npm run build
```

Reference inputs live in `packages/funding/{vectors,traces}.json` and are consumed by both Rust and TypeScript. Preview math cannot authorize a transaction or override applied contract state. Parameters are experimental defaults, not calibrated production recommendations. Internal deterministic research, the autonomous vault/Guardian feedback loop and integrated Trade funding/Autopilot UI remain proposed roadmap work. Real testnet custody is separately implemented in `strategy.rs` and documented in [VAULT_DESIGN.md](VAULT_DESIGN.md); it does not enable hedge trading. There is no standalone Stress Lab page in the finalized scope.
