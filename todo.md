# Reflex Perps — engineering roadmap

**Tagline:** Perpetual trading that adapts to the market.

**Track:** Unstoppable DeFi.

**State:** real testnet vault custody approved by the user and implemented; owner-signed strategy accounting and local PAPER hedge execution are implemented; genuine autonomous execution and integrated UI remain gated roadmap work. Ponytail is mandatory in `AGENTS.md`.

The NEAR migration is complete. Preserve the existing exchange and primary trading terminal. The product is one controlled loop: **market conditions → adaptive funding → net-carry evaluation → policy-approved hedge → updated market state**. This loop is a hypothesis to test, not a promise of profitable carry or healthier markets.

## Reading and status conventions

- Canonical architecture: [ARCHITECTURE.md](ARCHITECTURE.md); funding details: [docs/FUNDING.md](docs/FUNDING.md); evidence: [docs/EXTENSION_STATUS.md](docs/EXTENSION_STATUS.md).
- `[x]` means behavior verified for the stated **local scope**, not deployed or audited. `[ ]` means not started, partial, blocked or awaiting approval; the status text distinguishes them.
- P0 = safety/accounting or release blocker; P1 = core product; P2 = polish/research tooling. Priority is severity, not phase number. Dependencies refer to task IDs below.
- Paths marked **proposed** do not exist yet. Proposed methods/permissions must be designed and reviewed before coding; existing methods are named only where inspected.
- Current evidence: **111 exchange Rust tests, 4 funding Rust tests, 107 TypeScript tests, three NEAR Sandbox receipt-chain integrations and two Chromium funding fixture cases passed**; lint/typecheck/production build passed. These results cover the current working tree, including earlier uncommitted funding work—not a public deployment or independent audit. Browser wallet flows and the integrated Autopilot UX are not verified.
- No standalone Stress Lab route/page, migration work, NFTs/marketplace, unrelated exchange rewrite, unrestricted automation withdrawals, or guaranteed-return claims. Simulations stay internal CLI/test infrastructure; optional developer views are subordinate to Trade.

## Phase 0 — inspected baseline, approval and risk decisions

- [x] **A0 — P0: inventory authoritative exchange and market model.**
  - Existing/missing: verified MATCHED_ORDERBOOK; one paired long/short lot per match; no pool, vAMM or meaningful aggregate long-minus-short OI signal.
  - Modules: `contracts/exchange/src/{lib,model,trading,math,views}.rs`; `client/config/networks.ts` (engine/vault/order aliases); `docs/assumptions.md`.
  - Dependencies: none.
  - Acceptance: custody, matching, margin, oracle, funding, positions and liquidation are mapped; capped bilateral P&L and counterparty-triggered close are explicit constraints.
  - Tests/evidence: code inspection plus matching, capped-P&L, close, liquidation and custody tests in `tests.rs`; status: **verified locally**.

- [x] **A1 — P0: preserve and verify the existing exchange baseline.**
  - Existing/missing: deposits/refunds, order escrow, partial fills, reduce-only, nonces, lazy funding, locked-margin withdrawal rejection and callback recovery already work locally; interactive/public verification is missing.
  - Modules: `contracts/exchange/src/{tests,rounding_tests}.rs`; `client/lib/near/*.test.ts`; `client/scripts/sandbox.test.ts`; `client/package.json`.
  - Dependencies: A0.
  - Acceptance: existing test paths remain passing with current funding changes; Sandbox is never described as public testnet.
  - Tests/evidence: 78 exchange + 3 funding Rust tests, 33 TS tests; 2 Sandbox integrations, lint, typecheck and build passed; status: **verified local regression checkpoint only**, not a security audit.

- [x] **A2 — P0: approve scope, custody design constraints and implementation sequence.**
  - Existing/missing: the user's Phase 0 completion instruction authorizes the bounded implementation plan recorded in `docs/PHASE0_DECISIONS.md`; prior V0a custody approval is preserved. Genuine delegated authority and spot venue selection remain separate gates, not implicit approvals.
  - Modules: `ARCHITECTURE.md`, `reflex-perps-architecture.md`, `docs/{IMPLEMENTATION_PLAN,VAULT_DESIGN,PHASE0_DECISIONS}.md`.
  - Dependencies: A0–A1.
  - Acceptance: phased PAPER-first hedge work, isolated same-ledger per-strategy allocation, immutable owner/fixed payouts and deny-by-default real execution gates accepted; no exchange rewrite or pooled-share/NAV system. V0 reservation design and real authority/venue interfaces still require review before implementation/activation.
  - Tests/evidence: baseline re-executed: 78 exchange + 3 funding Rust tests, 33 TS tests, 2 actual-Wasm Sandbox integrations, lint/typecheck/build passed. Custody coverage includes 26 vault Rust tests; future trade authority requires V0/V2/V6/V8 policy/adversarial evidence. Status: **Phase 0 complete for scope/constraints/sequence only; no autonomous trading or deployment approval**.

## Phase 1 — funding engine verification and hardening

- [x] **F0 — P1: deterministic baseline and experimental premium-only funding math.**
  - Existing/missing: linear baseline, nonlinear adaptive target, absolute/slope caps, EMA, continuous soft deadband, bounded parameters and bigint preview are present and tested. Sampling/hysteresis review and MODEL_PAPER feedback calibration are completed for the F3 local research scope; production/runtime validation remains gated.
  - Modules: `packages/funding/{src/lib.rs,preview.ts,vectors.json,preview.test.ts}`; `docs/FUNDING.md`.
  - Dependencies: A0–A1.
  - Acceptance: signed truncation, 1e6 rates/premiums, hourly interval, correct payment direction, finite bounded outputs; shared vectors agree exactly. No pool-skew equation is applied to matched OI.
  - Tests/evidence: 3 Rust funding tests and 3 TS preview/vector/property tests passed; status: **verified locally for current default vectors/bounds**, not exhaustive calibration.

- [x] **F1 — P0: authoritative signals, configuration and index integration.**
  - Existing/missing: `update_funding` derives a validated recent-fill/index premium; owner-only `configure_funding` validates parameters/revisions. Old index accrues before price/rate/mode changes. No extra balance ledger.
  - Modules: `contracts/exchange/src/{controller,model,lib,math,trading}.rs`; `client/scripts/keeper.ts`; `controller_tests.rs`, `rounding_tests.rs`.
  - Dependencies: F0.
  - Acceptance: current-hour monotonic epochs; no replay/backfill; bounded rate lifetime; stale oracle rejection; zero-rate missing/stale/divergent-mark fallback; pair checkpoints/remainders and collateral-capped zero-sum payments retained.
  - Tests/evidence: local exchange suite and extended Wasm Sandbox tested application, replay rejection, settlement, owner-only mode changes, conservation and index expiry; status: **verified locally**, with further assurance tracked below.

- [x] **F2 — P0: align freshness, rate-expiry and fallback semantics across all consumers (local scope).**
  - Existing/missing: shared contract freshness now drives execution, match proposals, account health and liquidation discovery; readiness and keeper use the configured TTL and reject future timestamps. Atomic `funding_snapshot` now supplies chain time/status/markets to readiness and market funding APIs. APIs expose stored/effective ppm, expiry, inactive reason and snapshot time; both chain and wall-clock freshness are required, preventing expired/stalled snapshots from reviving rates. Keeper now uses the atomic finalized snapshot too; real CLI restart across a bounded stale-oracle gap is verified in Sandbox. Trade now shows mode/revision, signed hourly units/direction, stored/effective rates, snapshot/expiry, fallback and risk disclosures. Cached quote/readiness expires locally; RPC failures fail closed. Desktop/mobile Chromium fixture verification passes.
  - Modules: `contracts/exchange/src/{lib,views,math,controller}.rs`; `client/lib/near/{types,venue-api}.ts`; `client/features/network/useVenue.ts`; `client/scripts/keeper.ts`.
  - Dependencies: A2, F1.
  - Acceptance: one effective freshness rule for execution/readiness/proposals/UI; distinguish stored quote from accruing rate; explain zero fallback and emergency slope exceptions; no stale input authorizes new risk.
  - Required tests: shorter configured TTL, exact boundaries, keeper outage/restart, missing/evicted mark, future timestamp, API/contract disagreement, oracle valid but funding expired. Added 6 Rust and 6 TS tests covering configured TTL/risk/proposals, future timestamps, missing/evicted marks and oracle/rate expiry; existing outage/restart unit and both Wasm Sandbox regressions pass. Follow-up adds atomic snapshot/view nonmutation tests, clock-skew/stalled-snapshot/same-revision API tests, and finalized JSON-RPC Sandbox snapshot assertions. Current checkpoint: 95 exchange + 4 funding Rust, 65 TS, 2 desktop/mobile browser cases, lint/typecheck/build and 3 local Sandbox integrations passed. Sandbox now launches four independent real keeper CLI processes, verifies same-hour non-replay, stale-oracle skip, fresh-oracle recovery without gap backfill and conserved custody. Multi-hour restart remains unit-test evidence. Browser tests additionally verify exact cached expiry, readiness expiry, keyboard/touch disclosure, signed units, zero fallback and RPC failure. See `docs/PHASE1_ASSURANCE.md`. Server-clock skew can conservatively suppress readiness; no public wallet/browser validation is implied. Status: **F2 verified locally, including deterministic browser fixtures**.

- [x] **F3 — P1: finalize hysteresis, signal sampling and parameter calibration policy (local MODEL_PAPER research scope).**
  - Existing/missing: sampling/hysteresis review retains bounded last-opening-fill sampling, observation-based EMA and continuous soft deadband as the experimental reference, with <=4 ppm default zero-target quantization tolerance. Controller-only sweep and 30,240 endogenous market/PAPER-vault feedback runs are complete. No replacement passed the predefined cross-case no-regression filter; defaults/equations/authority remain unchanged. This is implementation-agent review of a versioned model, not independent review, empirically fitted production calibration or runtime Guardian completion.
  - Modules: `packages/funding/{src/lib.rs,preview.ts,vectors.json,traces.json,calibration.ts,calibration.test.ts,calibration-vectors.json}`; `client/scripts/calibrate-funding.ts`; `contracts/exchange/src/controller.rs`; `packages/sim/{ledger,feedback,research}.ts`, `packages/sim/{feedback.test.ts,accounting-vectors.json}`; `client/scripts/calibrate-feedback.ts`; `docs/{FUNDING,evaluation}.md`, `docs/calibration/`.
  - Dependencies: A2, F0–F2 core read/math work; uses the local-model subset of S0–S2 below. Broader S0–S3 runtime/product gates are not closed by this research checkpoint.
  - Acceptance: specify/review hysteresis (or explicitly justify retaining the soft-deadband design), sparse-market/missed-epoch policy and bounded mark estimator; parameter versions/change logs remain auditable; no unreviewed book-pressure input.
  - Tests/evidence: 15 joint feedback profiles × 14 scenarios × 3 training + 3 fresh holdout seeds × both demand signs × zero/weak/strong response × baseline/adaptive × vault off/on = 30,240 runs. Funding/payer/P&L caps, separate spot/perp custody, shared Rust/TS accounting vectors, failed/partial legs, counterparty exit, crash/negative P&L, costs, delta, reversion and exact JSON/CSV/trace replay are verified. All 997,920 dual-ledger frame/terminal checkpoints conserve. Replay: `cd client && npm run funding:calibrate && npm run funding:feedback && npm test`. Status: **F3 complete for the stated local model with a negative/no-adoption decision**. Last-fill manipulation, coarse timing/empirical assumptions and runtime strategy integration remain explicit release risks, not waived gates.

- [x] **F4 — P0: complete funding accounting/security assurance and deployment compatibility gate (approved implementation-agent review scope).**
  - Existing/missing: conservation/replay/remainder tests pass, including 12,800 seeded integer-reference settlements. Added 32 actual-contract configuration/matching cycles with 128 epoch/settlement/partial-or-full-close steps, exact TTL boundaries, history freezing and duplicate-settlement checks; 512 accepted parameter corners check cap/slope/symmetry. Legacy Market bytes at 01cc71a reject current decoding; current Market round-trips. Deployment now fails closed on code/data, RPC/malformed snapshot failures and overlapping exchange/oracle/token roles; fresh-to-code-bearing preflight rejection is rehearsed with actual Wasm in Sandbox. Added 90 price/size/margin/rate boundary combinations with both exit-price extremes, actual unfundable/min-notional order rejections and funded root-state round-trip/legacy-layout rejection. Full deployment CLI now passes fresh deployment, funded-storage no-op refusal, interrupted-code refusal and replacement recovery in Sandbox. Fixed optimistic-write/finalized-read sequencing by awaiting FINAL receipt outcomes. The user explicitly approved replacing independent F4 sign-off with documented implementation-agent accounting/security and deployment-compatibility review. That review is complete in `docs/F4_REVIEW.md`, with hashed source/artifact provenance, findings/dispositions and no new blocking defect identified in the local scope. Full archived-state migration is not certified. Fresh deployment is mandatory, not an in-place upgrade.
  - Modules: `contracts/exchange/src/{controller_tests,funding_assurance_tests,rounding_tests,tests,math}.rs`; `packages/funding/`; `client/scripts/{build-contracts.mjs,deployment-preflight.ts,deploy-testnet.ts,deploy-sandbox.test.ts,sandbox.test.ts}`; `client/lib/near/deployment-preflight.test.ts`; `docs/{FUNDING,OPERATIONS}.md`.
  - Dependencies: F2–F3 (settlement review can begin earlier).
  - Acceptance: all accepted parameter extremes preserve caps/conservation; old history is never rewritten; review index-checkpoint truncation, partial-close dust and collateral exhaustion. Drain/close the old deployment under original code before any replacement; never reset funded state.
  - Required tests: randomized rate/config/partial-close sequences, min/max price and size, both payment signs, oracle gaps, no double close/settlement, serialization incompatibility detection and fresh-account deployment rehearsal. New local assurance above passes; Sandbox server-clock simulation now follows its fast-forwarded chain only inside API tests, without weakening production freshness. Current rerun regression: 98 exchange + 4 funding Rust, 65 TS, 3 actual-Wasm Sandbox integrations, 2 Chromium browser cases, lint/typecheck/build passed. Three added tests explicitly verify both-sign checkpoint truncation bounds, partial-close fractional dust and duplicate full-close rejection. `docs/{PHASE1_ASSURANCE,F4_REVIEW}.md` record evidence, user approval, limitations and review disposition. Status: **F4 complete for the explicitly approved implementation-agent review scope; not an independent audit or public release approval**.

**Gate:** complete for reviewed/tested local deterministic contract behavior and consistent funding read models. F3 local-model completion is not a live-market improvement claim. F2 is locally complete; F4 is complete under the user-approved implementation-agent review requirement, not independent assurance. No public deployment, operator spending or autonomous trading is authorized by these results. Terminal integration follows in Phase 4.

## Phase 2 — real testnet custody, then hedge execution/risk testing

**Local implementation checkpoint:** V0–V7 complete for owner-signed strategy accounting and independent PAPER execution. V8's fail-closed gate is implemented, but genuine execution remains blocked by its separate authority/venue/release prerequisites. See [docs/PHASE2_ASSURANCE.md](docs/PHASE2_ASSURANCE.md); no live vault, public deployment or unrestricted automation is claimed.

- [x] **V0a — P0: implement real isolated testnet vault custody.**
  - Preserved actual allowlisted-token deposits, same-ledger strategy allocation, owner pause/release/withdraw/empty close, fixed owner payout, bounded pending requests and same-strategy callback recovery.
  - Modules: `contracts/exchange/src/{strategy,strategy_tests,lib,views}.rs`; `client/lib/near/{strategy,strategy.test,outcome}.ts`; `client/scripts/vault-sandbox.test.ts`; `docs/VAULT_DESIGN.md`.
  - Dependencies: A0–A1 and prior explicit real-custody approval.
  - Acceptance/evidence: original custody/refund/authorization/pending/storage/gas regressions and actual token payout/custody reconciliation pass. Status: **verified locally, not publicly deployed**.

- [x] **V0 — P0: complete strategy trading reservations and accounting (owner-signed local scope).**
  - Implemented reviewed same-ledger books, free reserve, escrow, attributed pair margins, nonce/history/statistics, funding/partial-close/liquidation routing and accounting reads. Manual paths cannot consume the owner's strategy side; another allocation cannot close/spend it. Cap includes escrow, effective lazy-funded margin and pending. No pooled NAV or second spendable ledger; same allowlisted six-decimal test token.
  - Modules: `contracts/exchange/src/{lib,model,trading,views,strategy,strategy_trading_tests}.rs`; `client/lib/near/{strategy,types}.ts`; `docs/{V0_RESERVATION_REVIEW,VAULT_DESIGN}.md`.
  - Dependencies: V0a, A2 policy constraints, F1/F4 local checkpoint. Reservation design/threat review recorded before implementation; implementation-agent review only.
  - Tests/evidence: **13 new Rust cases**, including populated-book prepaid storage, same-owner isolation, wrong-owner/manual-path bypass, partial fills/refunds, pending/locked withdrawal/caps, paused resting orders, funding/liquidation attribution and corrupted-reference audit. Extended actual-Wasm Sandbox verifies owner-signed escrow/matching, counterparty close and same-book real payout. **Fresh deployment mandatory**; historical F4 source hashes do not certify these new layouts. Status: **verified local owner-signed accounting, no delegation**.

- [x] **V1 — P1: define independent PAPER spot/perp adapters and normalized observations.**
  - Implemented separate durable adapter instances with per-leg quote identity/market/TTL/depth/slippage/fees, order/fill/finality status, balances, funding, marked P&L/equity and failure reporting. Shared implementation does not make execution atomic. PAPER prices explicitly use micro-USD rather than chain 1e18. PAPER assets never credit real exchange balances; receipts are null, not invented hashes.
  - Modules: `packages/adapters/{types,paper}.ts`; `packages/vault/phase2.test.ts`.
  - Dependencies: V0.
  - Tests/evidence: independent pending/partial/cancelled/rejected legs, expiry, unavailable venue, divergent markets/prices, insufficient cash/depth, deterministic client IDs and separate-ledger conservation. Status: **verified locally; genuine adapters absent**.

- [x] **V2 — P0: implement deterministic policy and lifecycle state machine (PAPER scope).**
  - Strict versioned schema and canonical immutable owner-confirmed policy hash. Gross, transient/residual delta and duration, reserve/marked margin, slippage, turnover, conservative net carry, per-action/total cost, cooldown and retries are bounded; open/reduce/close permissions are separate. All draft/quoting/opening/hedged/repairing/paused/unwinding/settled transitions are explicit.
  - Modules: `packages/risk/{policy,state-machine}.ts`; `services/guardian/guardian.ts`.
  - Dependencies: V0–V1.
  - Tests/evidence: every state-pair transition, wrong owner, policy tampering, numeric/schema bounds, disabled actions and exhausted budgets. Internal actor confirmation is trusted local configuration, **not wallet authentication or real delegated authority**. Status: **verified local PAPER policy only**.

- [x] **V3 — P1: implement opportunity evaluation and conservative hedge sizing.**
  - Evaluate finite uncertain collectible funding capped by payer collateral plus nonpositive basis change minus both-leg entry/exit fees/slippage and repair/reserve costs. Integer sizing never exceeds requested size, depth/participation, gross, transient delta or collateral. Positive gross funding alone never authorizes entry; early close/reversal can reduce collectible horizon to zero.
  - Modules: `packages/vault/{opportunity,sizing}.ts`; V1 quotes and V2 policy.
  - Dependencies: F2, V1–V2; finalized funding ingestion remains Phase 3, not fabricated here.
  - Tests/evidence: positive gross/negative net, reversal before break-even, payer cap, margin/depth/reserve/divergence rejection, capacity sizing, zero/no-op and pessimistic assumptions. Status: **verified local deterministic estimates; no return claim**.

- [x] **V4 — P0: reconcile execution idempotently and track both legs (PAPER scope).**
  - Stable strategy/epoch/action/leg IDs, durable pre-submit intents, independent cumulative fills/pending orders and monotonic revision checks. Restart/timeout queries the venue; unknown outcome pauses instead of blind retry. Only reconciled fills grow expected exposure; external reductions are separately logged/reconciled, unexplained changes stop execution.
  - Modules: `services/guardian/guardian.ts`; `packages/vault/store.ts`; independent adapter stores.
  - Dependencies: V1–V3.
  - Tests/evidence: duplicate dispatch/events, partial revisions, out-of-order/conflicting state, timeout then success, restarted workers, unknown receipt and retry exhaustion. Single-host exclusive writers; crash-held locks fail closed pending operator inspection (documented procedure). Status: **verified local durable reconciliation, not live venue finality**.

- [x] **V5 — P0: implement monitoring, bounded repair and circuit breakers (PAPER scope).**
  - Monitor actual residual delta/duration, bounded funding observation, free reserve, marked margin/equity, depth, costs and P&L caps. Detect unilateral counterparty removal and capped hedge effectiveness before/after settlement. Repair only reduces surplus exposure within policy; unavailable/unsafe/exhausted conditions stop, never assume atomic legs.
  - Modules: `packages/risk/watchdog.ts`; `services/guardian/guardian.ts`; existing contract position/liquidation views.
  - Dependencies: V2–V4.
  - Tests/evidence: partial/failed second leg, counterparty exit, capped crash gains, funding conservation/reversal, stale/unavailable venue/oracle, reserve/margin limits, depth/cost/retry constraints. Actual attributed liquidation is tested in Rust; PAPER is not a full NEAR liquidation-penalty emulator. Caller-driven watchdog, not an unattended deployed service. Status: **verified local bounded monitoring/repair**.

- [x] **V6 — P0: support owner pause, bounded close and settled withdrawal (local/PAPER scope).**
  - Owner stop prevents unsent opens/repairs but retains and reconciles in-flight events. Bounded unwind first stops submissions, cancels known pending orders, then independently reduces actual legs under fresh oracle/venue/depth/cost/turnover/retry constraints. Unknown receipts block unwind. Real available settled custody withdrawal stays owner-wallet-signed to immutable owner; automation has no withdraw/payout/policy/owner mutation API.
  - Modules: `contracts/exchange/src/{strategy,trading}.rs`; `client/lib/near/strategy.ts`; `services/guardian/guardian.ts`.
  - Dependencies: V0, V4–V5.
  - Tests/evidence: owner stop with pending/late fill, denied post-stop submission, cancellation/reconciliation, forged owner/manual/foreign-strategy close, escrow withdrawal rejection, receipt replay/refund recovery, unavailable exit and bounded retries; Sandbox verifies real fixed-owner token payout. Full-access signing keys are never called restricted keys. Status: **verified locally; real custody automation remains disabled**.

- [x] **V7 — P1: record every decision and replay it (local scope).**
  - Strategy/mode/policy revision/hash, epoch/config revision, normalized inputs, reason, result/receipt and costs are durable. Hash-chain replay also recomputes opportunity economics, monotonic cumulative receipts and total observed costs, including external exits. Proposal skips, repair/unwind declines, submissions, receipts, external changes, pause and observations are retained. Sensitive field names are redacted; exception text is not logged.
  - Modules: `packages/vault/{events,replay,store}.ts`; `services/guardian/`.
  - Dependencies: V2–V6.
  - Tests/evidence: deterministic economic/audit replay, skipped decisions, duplicate ingestion, restarts, corrupted journals, exclusive writer refusal, redaction and bounded capacity. Private offline archival/stop-before-capacity policy is in `docs/PHASE2_ASSURANCE.md`; no silent eviction of pending records. Status: **verified local single-host journal, not tamper-proof against host compromise**.

- [ ] **V8 — P1: gate genuine NEAR/spot execution separately from PAPER.**
  - Implemented explicit readiness blockers in `packages/adapters/execution-gate.ts`; Guardian rejects genuine/mixed adapters. Ship/run the clearly labeled PAPER CLI (`cd client && npm run vault:paper`) alongside preserved manual owner-signed NEAR trade, not a fake live delta-neutral vault. No venue or bridge/Intents integration was invented.
  - Dependencies: F4, V0–V7, S1–S3, D1 and **separate explicit real-trading/venue approval**.
  - V8 feasibility investigation: [docs/V8_FEASIBILITY_REVIEW.md](docs/V8_FEASIBILITY_REVIEW.md). The user approved **Option 2 in principle**: reuse an existing Rhea/Ref testnet pool/token; no custom faucet-token requirement. The unfinished [Option 2 audit](docs/v8/OPTION2_AUDIT_IN_PROGRESS.md) preserves exact pool/token IDs, pinned reserve/quote/metadata/code/permission/storage observations and identified blockers. No specific pair or implementation is approved yet; no deployment, pool creation, liquidity addition, swap or spending is authorized. V8 remains unchecked.
  - **Paused-session checkpoint:** [Option 2 compatibility decision/plan](docs/v8/OPTION2_COMPATIBILITY_REVIEW.md), [latest pinned reads](docs/v8/option2-latest-check.json), [non-executable fresh deployment proposal](docs/v8/fresh-exchange-proposal.json), and [offline evidence verifier](docs/v8/verify-option2.py) were added locally after the last push. Latest finalized block: **277330507** (`5kKtXYVAUo9ZYpUTwotMjkoZZx3QUYHFFSCvgMgxemgR`). Six simple-pool quote results matched integer arithmetic; two DEGEN quotes still rejected with `E129: Degens expired`. Pools 2642/2926/2939 have 30/30/25-bps spot fees per swap; their comparable-notional roundtrip fees exceed the current 20-bps/hour funding cap over the one-hour forecast. Pool 2939 also lacks minimum-hedge depth at the tested 20-bps impact setting. No deployable pair is recommended under unchanged policy. No contract/adapter implementation, deployment, swap or spending occurred.
  - **Resume here:** run `python3 docs/v8/verify-option2.py` from `NEARFlow/` (new verifier has not yet been run), review the new assessment/proposal and pending Git changes, and resolve exact pair/route feasibility plus implementation approval before changing real-execution code. The new assessment/artifacts and this todo update are **not committed/pushed**. Preserve the existing disabled execution gate and fresh-account-only rule; do not silently relax horizon/slippage/net-carry constraints to force entry. Full V8 and its public signed-receipt/security gates remain incomplete.
  - Still required: review contract-enforced delegated trade limits, genuine spot custody/liquidity/finality, asynchronous signed receipt handling and dedicated funded roles. Signed two-leg integration, recipient restrictions, failed/partial receipt reconciliation, venue custody balances and safe live restart are **not verified**.
  - Status: **fail-closed gate verified; genuine execution blocked by authority/venue/approval and later-phase release prerequisites**. This checkbox is deliberately not marked complete merely because PAPER passes.

**Gate:** local PAPER entry/skip, independent exposure visibility, bounded repair/pause/unwind and ownership/accounting invariants pass. Checkpoint: **111 exchange Rust + 4 funding Rust tests**, **89 TypeScript tests (including 23 new PAPER tests and a wallet-helper test)**, **3 actual-Wasm Sandbox integrations**, lint, combined typecheck and production build. Real funds, public deployment, genuine spot and delegated trading remain separately gated. See `docs/PHASE2_ASSURANCE.md` for evidence, operator recovery and material limitations.

## Phase 3 — connect funding and vault decisions

- [x] **C0 — P1: implement the explicit funding → opportunity → execution loop (local PAPER scope).**
  - Implemented read-only finalized atomic funding ingestion, strict schema/network/clock/expiry checks, immutable membership/policy bindings, one decision per strategy/epoch, durable pre-submit group reservations and independently reconciled PAPER execution. Network clocks are rechecked after RPC; source cannot sign or update funding.
  - Modules: `services/guardian/{funding-source,funding-loop}.ts`; `packages/{vault,risk,adapters}/`; existing keeper/controller unchanged. `PaperAdapter.quote()` now exposes finite remaining depth and `marketView()` observed fills.
  - Dependencies: F2, V3–V7 for PAPER. Equations/defaults remain unchanged; genuine execution remains V8/F4/S3/D1-gated.
  - Tests/evidence: accepted and net-negative declined opportunities, pending/partial/full reconciliation, replay/restart checkpoint, competing workers and pre-submit reconfiguration. Actual-Wasm Sandbox advances two consecutive funding epochs, reads finalized rates (400 → 720 ppm), waits for persistence and executes an allowed independent PAPER hedge. PAPER depth decreases; real balances and matched OI stay unchanged. No PAPER-to-chain premium/price/OI effect is invented.
  - Status: **verified local fixtures + actual finalized Sandbox-to-PAPER connector; not a genuine on-chain feedback loop**. See `docs/PHASE3_ASSURANCE.md`.

- [x] **C1 — P0: limit endogenous feedback and funding chasing (local PAPER scope).**
  - Implemented separate entry/exit thresholds, >=2 consecutive same-revision epochs, gap/reversal/fallback reset, market cooldown, one group entry per epoch, shared epoch/daily gross-flow and cost reservations, index/quote divergence and depth/participation checks. Reserve entry plus conservative exit/repair flow; never recycle rejected/unknown reservations into a new entry. Existing per-strategy delta/reserve/margin/turnover/cost/retry bounds remain enforced.
  - Modules: `packages/risk/feedback.ts`; C0 coordinator and V2 policy. F3's model remains separate research, not runtime proof of market improvement.
  - Dependencies: C0, V2–V5.
  - Tests/evidence: gaps/reversals, multiple strategies competing for shared allowance, projected own premium reversion with zero chain response, same-epoch anti-recursion, conservative net-cost declines, depth loss and exhausted daily budgets. Status: **verified deterministic local safeguards; not empirically fitted production calibration**.

- [x] **C2 — P1: reconcile market and strategy risk after external changes (caller-driven local scope).**
  - Controller mode/revision/epoch/index/fallback, expired/stalled/conflicting source data, venue risk, policy mismatch or owner stop invalidate old plans. Stop unsent actions, cancel only known pending orders, reconcile late receipts and residual inventory; unknown outcomes are retained, never blindly resubmitted. Counterparty removal permits only policy-approved surplus reduction within the pre-reserved cost allowance. Fully reconciled flat repair settles terminally.
  - Modules: V4–V5, `services/guardian/funding-loop.ts`; existing contract read models. No unattended daemon, unrestricted owner exit or genuine executor is installed.
  - Dependencies: C0–C1.
  - Tests/evidence: mid-leg config change, changed index, expiry/RPC outage, regressed/conflicting finalized frames, owner stop, late partial success after unknown receipt, restart/event reconciliation, shared repair budgets and counterparty-close residual spot repair. Phase 2 cap/margin/liquidation evidence is preserved. Status: **verified local stop/reconcile/repair; real external finality and integrated S1–S3 remain gated**.

**Gate:** **passed for local PAPER scope**: a positive-gross/net-negative opportunity is deliberately declined; an allowed hedge obeys persisted policy/flow bounds. **107 TS tests (18 new loop/source tests)**, **111 exchange + 4 funding Rust tests**, **3 Sandbox integrations** (including the actual finalized two-epoch PAPER connector), **2 Chromium funding fixtures**, lint/typecheck/build pass. Source clocks and the oracle publisher's current-chain timestamp are handled explicitly in Sandbox; no public execution or market-stabilization claim. See `docs/PHASE3_ASSURANCE.md` for precise evidence, long-running Sandbox harness fixes and limitations.

## Phase 4 — integrate into the existing trading terminal

- [ ] **U0 — P1: show transparent funding in Trade.**
  - Existing/missing: funding-rate projection and user payment history exist; controller mode, effective accrual/fallback, input freshness and projected funding costs are not integrated.
  - Modules: `client/features/trade/components/{MarketHeader,MarketDataProvider,FundingHistoryTable,OrderEntry,PositionsTable}.tsx`; `client/lib/near/{types,venue-api}.ts`; `client/stores/market.ts`.
  - Dependencies: F2–F4.
  - Acceptance: show baseline/adaptive, interval/ppm-to-bps units, payer direction, timestamp, fallback/expiry and experimental explanation; projected position costs use a stated horizon/rate assumption, not promised APR. Separate payment history from rate history and label bounded retention.
  - Required tests: rate sign/units, non-accruing stale quote, no-history/RPC error, estimate rounding and keyboard/screen-reader access; status: **partial read infrastructure only; new UI missing**.

- [ ] **U1 — P1: add an Autopilot / Delta-Neutral Vault panel in Trade.**
  - Existing/missing: responsive manual terminal exists; strategy allocation/policy/monitoring UI does not.
  - Modules: preserve `client/app/trade/[market]/page.tsx`, `TradeTerminalGrid.tsx`, `BottomPanel.tsx`, `DepositWithdrawDialog.tsx`; **proposed** `client/features/autopilot/`.
  - Dependencies: V0–V7, C0–C2; initial funding-only U0 can ship first.
  - Acceptance: allocation and policy confirmation, independent spot/perp fills/pending orders, reserve, net delta, margin health, realized funding, realized/unrealized/net P&L after costs, decision reasons and pause/close/settled-withdraw controls. Manual Trade remains the default. Execution mode appears per leg; PAPER allocation cannot move real collateral.
  - Required tests: responsive/loading/empty/error states, disconnected wallet, failed leg and bounded repair, pause with pending orders, close/withdraw failures, focus/keyboard controls; status: **missing**.

- [ ] **U2 — P0: expose validated read/quote/proposal data without bypassing signatures.**
  - Existing/missing: finalized read APIs exist; POST currently returns 405. Strategy reads, quotes/proposals and rate-history archive are missing.
  - Modules: `client/app/api/[...path]/route.ts`, `client/lib/near/{venue-api,outcome,wallet}.ts`; **proposed** strategy read/proposal modules; V7 event persistence.
  - Dependencies: F2, V2–V7, C0; API schema approval required before exposing new routes.
  - Acceptance: validate account/strategy ownership, numeric bounds, request size, timeouts and resource/rate limits. API returns estimates/proposals only; real mutations require wallet or contract-enforced restricted delegation, nonce/epoch and on-chain policy. Never invent endpoint support or receipt hashes.
  - Required tests: unauthenticated proposal/read leakage, foreign strategy, malicious numeric payloads, invalid network, request abuse, stale/duplicate plans and forged signing authority; status: **partial existing read APIs; new proposal/read schema missing**.

- [ ] **U3 — P2: align user-facing branding and disclosures with Reflex Perps.**
  - Existing/missing: app still uses NEARFlow branding; final product name/tagline are documentation decisions, not implemented UI.
  - Modules: `client/app/{layout.tsx,page.tsx}`, `client/components/common/TopNav.tsx`, `client/features/network/components/{NetworkBadge,NetworkBanner}.tsx`, `client/public/`; README and documentation.
  - Dependencies: A2, U0–U1.
  - Acceptance: Reflex Perps and tagline in user-facing surfaces; preserve repository directory, contract identifiers, account IDs and event/storage namespaces unless separately reviewed. No Lab navigation, NFT content, production/guaranteed-return or fully-onchain PAPER claims.
  - Required tests: copy/link/metadata audit, route smoke, accessible assets and mode/disclosure visibility; status: **missing app polish**.

**Gate:** existing trade flow stays intact; funding and Autopilot are coherent parts of it. No standalone Stress Lab page.

## Phase 5 — internal deterministic research and end-to-end validation

Start the internal harness alongside Phase 2 after F2 and V1; complete this gate before enabling C0/V8 real execution.

- [ ] **S0 — P1: build seeded, versioned internal scenario infrastructure.**
  - Existing/missing: F3 now supplies a versioned internal matched-lot/PAPER-hedge model, seeded scenarios, finite independent ledgers and provenance/replay artifacts in `packages/sim/` and `docs/calibration/feedback/`. It is not the runtime PAPER adapters/Guardian or a full resting-order-queue emulator; broader adapter/strategy integration remains missing.
  - Modules: **proposed** `packages/sim/`, `fixtures/scenarios/`, `scripts/evaluate.ts`; reuse funding math and PAPER adapters.
  - Dependencies: F0–F2, V1; strategy scenarios additionally need V2–V7.
  - Acceptance: identical seed produces identical exogenous price path, arrivals, liquidity and fees for both arms; explicit funding-responsive trader/vault behavior; fixed-point capped bilateral matching/margin/settlement, including early close/liquidation and spot custody separation. No invented insurance shortfall from an uncapped model.
  - Required tests: deterministic snapshots, fixture validation, known-trace settlement reconciliation and same-input assertions; status: **missing; internal tooling only**.

- [ ] **S1 — P0: cover funding/hedge failure and conservation scenarios.**
  - Existing/missing: F3 MODEL_PAPER feedback scenarios now cover price/flow extremes, sparse/manipulated marks, oracle/keeper gaps, spot failure, partial pending legs, counterparty exit and capped crash losses with conservation. Phase 2/3 now add deterministic actual-adapter/Guardian fixtures and a finalized Sandbox-to-PAPER connector, including restart/unknown receipts and external-change cases. The full seeded combined runtime/finality/restart matrix remains missing; neither model nor these selected cases complete this product gate.
  - Modules: S0 fixtures; **proposed** `packages/sim/*.test.ts`; existing Rust and Sandbox suites.
  - Dependencies: S0, V4–V7, C0–C2 for closed-loop cases.
  - Acceptance: extreme buy/sell demand, spikes/reversals, crashes, low liquidity, partial fills, stale/conflicting oracles, liquidation, counterparty exits, overshoot, retries and rebalance costs; distinguish directional order pressure from equal matched OI.
  - Required tests: both signs, three seeds/scenario minimum, zero/weak/strong trader sensitivity and multi-strategy feedback; every run checks collateral conservation, no duplicate exposure and policy limits; status: **missing combined tests**.

- [ ] **S2 — P1: compare baseline vs Reflex without assuming an advantage.**
  - Existing/missing: F3 controller and MODEL_PAPER feedback reports now publish seeded baseline/adaptive and vault-off/on ablations, sensitivity, negative outcomes, all-run CSV, JSON aggregates and source/input provenance. Full actual-adapter/Guardian evaluation, empirically fitted assumptions and broader S1 runtime evidence remain missing; research scope is documented in `docs/evaluation.md`.
  - Modules: **proposed** `packages/sim/{metrics,export}.ts`, `docs/evaluation.md`; `docs/FUNDING.md` calibration notes.
  - Dependencies: S0–S1; feed results back into F3 and C1.
  - Acceptance: identical exogenous conditions and policies; run controller-only and vault-enabled/disabled arms to isolate feedback effects. Measure premium/reversion, funding peaks/jumps, oscillation, margin/liquidation, drawdown, delta size/duration, repair costs/fees, realized/unrealized net P&L and settlement residuals. Publish actual negative/no-improvement outcomes.
  - Required tests: metrics against hand-computed traces; JSON/CSV round-trip with scenario version, seed, source revision/dirty-state provenance, parameters and outputs; documented CLI replay and sensitivity sweep; status: **missing**.

- [ ] **S3 — P0: complete security review, CI and full terminal/automation regression.**
  - Existing/missing: local exchange/controller suites pass; vault security review, browser E2E and integrated CI gate are missing.
  - Modules: existing `client/package.json`, contract tests and Sandbox; **proposed** `client/tests/e2e/`, CI workflow, `docs/threat-model.md`.
  - Dependencies: F4, V0–V7, C0–C2, U0–U2, S1–S2.
  - Acceptance: review authorization/delegation, custody allocations, callback/refund, overflow, epoch/nonce replay, oracle manipulation, last-fill manipulation, policy tampering and external spot finality. Existing manual trade remains usable; no unexplained balance/delta residuals. Clean-install tests/lint/typecheck/build/Sandbox pass.
  - Required tests: browser manual trade and PAPER Autopilot flows, failure recovery, all existing/new unit/property/integration scenarios, secret/dependency scans; status: **not started for integrated product**.

## Phase 6 — NEAR verification and hackathon demo

- [ ] **D0 — P1: update setup, risk, provenance and evaluation documentation.**
  - Existing/missing: setup/operations and funding docs exist; vault operations, research results, final branding and new-vs-pre-existing feature inventory are missing.
  - Modules: `README.md`, `client/README.md`, `docs/{OPERATIONS,assumptions,EXTENSION_STATUS,FUNDING}.md`; proposed vault/threat/evaluation docs.
  - Dependencies: U3, S2–S3.
  - Acceptance: clean-clone commands, parameter versions, trust boundaries, fixed-token/capped-P&L limitations, mode labels and honest failure results; no migration/NFT/Lab-page tasks return.
  - Required tests: independent reproduction of documented commands and evidence/link audit; status: **partial documentation; final product docs pending**.

- [ ] **D1 — P0: provision and verify a fresh public NEAR testnet deployment.**
  - Existing/missing: build/deploy/oracle/keeper scripts exist and local receipts pass. Operator `reflex-operator-49c6b7.testnet` and its funding are verified by finalized read-only RPC; full-access credentials remain outside Git. No exchange/token deployment, dedicated deployment/oracle roles, public wallet flow or release approval is established by operator provisioning.
  - Modules: `client/.env.local.example`, `client/scripts/{deploy-testnet,oracle,keeper,near-runtime}.ts`; `docs/OPERATIONS.md`; F4 deployment policy.
  - Dependencies: F4, S3 for release; operator-controlled funded contract/token/oracle/trader accounts. V8 additionally required for any claimed genuine live hedge.
  - Acceptance: configure local credentials without committing them; fresh deployment, token match and oracle readiness; manual wallet connect/register/deposit/long/short/partial-full close/funding/liquidation/withdraw checks with actual receipt links. Never reuse incompatible funded storage.
  - Required tests: public wallet smoke plus repeated readiness/epoch/authorization checks; retain Sandbox as separate evidence; status: **operator provisioned/funded; dedicated deployment roles and release gates still block deployment**.

- [ ] **D2 — P1: rehearse a 100–120 second integrated demo.**
  - Existing/missing: working local manual trade exists; automated strategy and final demo are missing.
  - Modules: existing Trade terminal and U0–U2 panel; **proposed** `docs/DEMO.md`; controlled PAPER/testnet fixture runner, not a Lab page.
  - Dependencies: D0–D1, U0–U3, S3; V8 only if showing genuine two-leg execution.
  - Acceptance: (1) actual NEAR perp trade, (2) bounded adaptive funding response, (3) user activation/policy, (4) risk-approved hedge or explicit skip, (5) reversal/imbalance, (6) bounded repair/reduce/pause, (7) transparent costs/funding/P&L/margin. Failure injection is PAPER/local-sandbox only; distinguish each leg's mode and evidence. A mixed PAPER-spot/testnet-perp demo is not a live onchain vault.
  - Required tests: timed rehearsal including declined opportunity, duplicate retry, manual pause and failed-venue path; verify every transaction link and displayed figure; status: **missing; public claims gated by D1**.

- [ ] **D3 — P2: publish approved repository/demo with operator accounts.**
  - Existing/missing: local repository exists; authorized remote/submission and final evidence bundle need operator confirmation.
  - Modules: repository configuration, README, `docs/DEMO.md`, deployment/evaluation artifacts.
  - Dependencies: D0–D2 and operator approval of destination/accounts.
  - Acceptance: Unstoppable DeFi submission emphasizes the tested funding–hedging interaction; no fabricated returns, live spot, public deployment or audit claims. No credential publication or guessed remote.
  - Required tests: secret scan, clean-clone reproduction and submission/link check; status: **not started / operator-dependent**.

## Proposed approval order

1. Preserve the verified exchange/controller/custody checkpoint (V0a); real testnet custody is user-approved.
2. Harden funding consistency F2, decide F3 behavior; build S0 harness and extend V0a custody with V0 strategy trading reservations after policy review.
3. Implement PAPER adapters → policy/opportunity → idempotent execution → monitoring/repair → owner exit/audit (V1–V7).
4. Connect the controlled feedback loop C0–C2; use S1–S2 results to calibrate F3/C1; finish F4 assurance.
5. Integrate funding and Autopilot **inside Trade** (U0–U3), not a standalone Lab.
6. Pass S3 security/regression; then separately approve real adapters/public deployment (V8/D1), documentation and demo.

**Current approval:** Phase 0 scope/constraints/sequence accepted in [docs/PHASE0_DECISIONS.md](docs/PHASE0_DECISIONS.md); real testnet custody first is implemented as V0a. Phase 1 funding and F4 implementation-agent review are complete for their documented local scopes under explicit user approval in [docs/F4_REVIEW.md](docs/F4_REVIEW.md). Same-ledger owner-signed strategy reservations and independent PAPER hedge testing (V0–V7) are now implemented and locally verified; see [docs/PHASE2_ASSURANCE.md](docs/PHASE2_ASSURANCE.md). C0–C2 finalized-read PAPER coordination is also locally verified in [docs/PHASE3_ASSURANCE.md](docs/PHASE3_ASSURANCE.md). V8 genuine execution remains blocked by separate authority/venue approval and S1–S3/D1 prerequisites. Genuine spot execution, delegated real trading, public deployment, operator spending and publication remain separately gated.
