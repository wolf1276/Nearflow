# Reflex Perps — 35-commit delivery plan

Each numbered item is a focused commit, not an empty checkpoint. A commit is made only after its stated gate passes. Preserve the existing matched-orderbook exchange, custody ledger, keys, storage namespaces and tests. No invented LP skew, external trades or public deployment evidence.

| # | Commit scope | Passing gate |
|---|---|---|
| 1 | `chore: initial setup` — existing NEAR exchange baseline and assumptions | Existing Rust/TS tests, Sandbox receipts, typecheck/lint/build pass; public-deployment blocker documented |
| 2 | Record this delivery plan, verification and push policy | Plan identifies isolated extension points and remote prerequisite |
| 3 | Funding signal schema, fixed-point units and parameter bounds | Invalid units/model/parameters rejected in unit tests |
| 4 | Conventional premium-driven TypeScript baseline | Sign, linear response and absolute-cap tests |
| 5 | Experimental premium-driven TypeScript Reflex controller | Continuous deadband, smoothing, slope/absolute caps and invalid-input fallback tests |
| 6 | Pure Rust funding baseline | Fixed-point and extreme-input unit tests |
| 7 | Pure Rust Reflex controller and guardrails | Rust cap, continuity, monotonic epoch and fallback tests |
| 8 | Cross-language funding vectors | Rust and TS consume identical versioned vectors and agree exactly |
| 9 | Matched-orderbook FundingSignal adapter | Recent mark separate from oracle; no net-OI signal; stale-input tests |
| 10 | Separate funding-controller metadata storage | Existing Exchange/Market/Pair serialization remains compatible |
| 11 | Owner-restricted, versioned controller configuration | Authorization, parameter bounds and change-log tests |
| 12 | Lazy controller/index integration and views | Accrue previous rate before updates; preserve checkpoints and collateral invariant |
| 13 | Adversarial controller/settlement properties | Replay, gap, rounding, reversal and conservation tests |
| 14 | Extended NEAR Sandbox funding smoke tests | Actual Wasm switches modes without phantom balances; existing smoke tests preserved |
| 15 | Versioned seven-scenario fixtures | Schema validation and stable fixture identities |
| 16 | Seeded deterministic path/order generator | Identical seed generates identical exogenous inputs |
| 17 | Explicit trader funding-response model | Both arms receive the same shocks; zero-sensitivity behavior tested |
| 18 | Simulator collateral/margin/price-gap accounting | Use the existing capped bilateral model; expose shortfall definitions honestly |
| 19 | Stress metrics, oscillation and failure measurement | Derived metrics tested against known traces |
| 20 | Reproducible JSON/CSV export and run identities | Parameters, source version, seed and outputs round-trip |
| 21 | Sensitivity sweeps and reproducible evaluation fixtures | At least three seeds/scenario; zero/weak/strong response; report negative results |
| 22 | Labeled paper spot/perp execution adapters | Partial/failed/pending fills represented independently |
| 23 | Guardian policy bounds, owner and permission model | No withdrawal or arbitrary recipient actions; turnover/gross/reserve limits tested |
| 24 | Deterministic Guardian state machine | Authorized transitions and invalid-transition rejection |
| 25 | Stable execution IDs and reconciliation | Duplicate/out-of-order status events cannot duplicate exposure |
| 26 | Bounded repair, pause and unwind decisions | Retry/cost/oracle limits, manual stop and pending reconciliation tests |
| 27 | Guardian scenario integration and telemetry | Failed-leg/delta duration, costs, policy hash and reason reproducible |
| 28 | Funding, strategy-preview and Lab read APIs | Validated requests, bounded resource use and clear mode labels |
| 29 | Simulation/quote/proposal APIs | No real-funds mutation or forged on-chain authority; input-size/rate limits |
| 30 | Stress Lab comparison UI | Real shared-time data, scenario/seed/sensitivity controls, play/reset/export, accessible table |
| 31 | PAPER Autopilot UI and break-hedge demo | Independent fills, repair/retry/pause/close and visible policy/cost/delta |
| 32 | Trade funding state and Reflex navigation | Existing trade journey retained; rates/interval/model/environment visible |
| 33 | Research, threat model and evaluation documentation | Formulas/trust/capped-PnL differences and negative results disclosed |
| 34 | Browser smoke tests and 120-second demo runbook | Trade/Lab/PAPER Guardian journeys verified; public-testnet signing not fabricated |
| 35 | CI, clean-install reproducibility and submission review | Full existing+new suite/build, branding/secret scan; final report and push if remote available |

## Verification policy

- Run the narrow test for each commit; full suites at phase boundaries and final review.
- Do not commit failing/incomplete modules simply to reach a number. Amend the plan with evidence if a task needs splitting; remain within the requested 30–40 meaningful commits.
- Contract controller storage must be additive; do not silently reset or migrate the exchange ledger.
- Existing NEAR custody/settlement remains authoritative. The default Guardian demo is PAPER and cannot move funds.
- Public testnet wallet verification requires funded accounts and operator signing. An absent deployment remains a documented blocker, not a passing test.

## Git and push policy

The working repository is the existing Git root above `NEARFlow/`; initial setup commit is `4910d16` on `master`. No remote was configured when this plan was created. The owner must supply the destination repository URL (or configure a remote) before any push. Never push to the cloned source repository, guess a GitHub owner, publish credentials, force-push, or bypass hooks. Once a destination is authorized, push passing phase checkpoints and the final branch normally, preserving history.

## Status

- Commits 1–2: baseline and plan recorded.
- Public testnet deployment: not configured.
- Push: blocked pending destination repository URL.
