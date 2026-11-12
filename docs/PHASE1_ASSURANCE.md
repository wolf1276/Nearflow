# Phase 1 assurance handoff

Status: **F4 complete for the user-approved implementation-agent review scope**. The user explicitly approved replacing F4's independent-review requirement; [F4_REVIEW.md](F4_REVIEW.md) records authorization, reviewed content hashes, findings/dispositions and rerun evidence. This is not an independent audit, deployment approval or public-testnet validation. F0/F1/F2 are locally verified; F3 is complete only for its documented MODEL_PAPER research scope.

## Reproduce the verified checkpoint

From `NEARFlow/`:

```sh
cargo test --locked --manifest-path contracts/exchange/Cargo.toml
cargo test --locked --manifest-path packages/funding/Cargo.toml
cd client
npm ci
npx playwright install chromium --only-shell
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run test:sandbox
npm run build
```

Observed results after the approved F4 review: **98 exchange Rust tests, 4 funding Rust tests, 65 TypeScript tests, 2 Chromium browser cases, 3 actual-Wasm Sandbox integrations**, plus passing lint/typecheck/production build. Browser cases run desktop Chrome and Pixel 7 emulation, not physical devices or wallet signing. Sandbox 2.14.0 uses generated local credentials, not the funded public operator. `npm test` verifies calibration source/input hashes and replay artifacts; full research regeneration commands remain in [evaluation.md](evaluation.md).

## F2 browser evidence

`client/tests/e2e/funding.spec.ts` exercises the existing Trade route with intercepted API/RPC fixtures and a controlled browser clock. External browser requests are aborted; no public transactions are signed. It verifies:

- Positive/negative hourly rates, ppm-to-bps units and payer direction.
- Adaptive/baseline mode, revision, stored versus effective quote, snapshot and expiry disclosures.
- Exact expiry makes the effective quote zero even when successful cached responses remain unchanged; expired cached readiness fails closed locally.
- Zero fallback, unavailable RPC, no assumed rate after RPC failure, capped-collateral/counterparty-close and emergency slope exceptions.
- Keyboard Enter/Escape, restored trigger focus, touch/click disclosure and dialog viewport containment on both projects.

Active/error screenshots are generated under ignored `client/test-results/`; active mobile and error mobile screenshots were visually inspected. These are deterministic browser fixtures, not proof of public RPC availability, a real wallet round trip, or cross-browser accessibility certification. Multi-hour keeper recovery remains unit-test evidence; the bounded outage/process-restart path is actual Sandbox evidence.

## F4 accounting and compatibility evidence

`contracts/exchange/src/{rounding_tests,funding_assurance_tests,controller_tests}.rs` covers 12,800 seeded independent-reference settlement steps, actual-contract configuration/matching/partial-close sequences, history preservation, repeated settlement/close rejection and 512 parameter corners.

The price/size boundary matrix adds **90 combinations**, each with two exit-price extremes: prices 1/1e18/MAX_PRICE, sizes one atom/maximum 1e15 atoms, margins zero/one/5e9 collateral atoms and rates -2000/-1/0/+1/+2000 ppm. It checks independent quotient/remainder arithmetic, both payer caps, expiry freezing and funding/P&L conservation. These are arithmetic-domain tests, not claims that every extreme notional is fundable. Actual order entry rejects the minimum-price/minimum-size combination below minimum notional and the maximum-price/maximum-size combination above free collateral.

Legacy Market bytes and the pre-strategy root Exchange field layout at revision `01cc71a` reject current decoding. Current funded Exchange state round-trips with identical root bytes, conserved audit and preserved pair count. This detects incompatibility; it is not a full archived-state migration test or a migration implementation. The only supported deployment policy is a fresh code-free/data-free account. No funded state is reset or upgraded.

## Actual deployment-command and recovery rehearsal

`client/scripts/deploy-sandbox.test.ts`, included by `npm run test:sandbox`, launches the actual deployment CLI against local Sandbox, with temporary directory/private-key files outside Git (files mode 0600, removed in `finally`). It verifies:

1. Fresh token/exchange deployment, initialization, active-market setup and storage registrations.
2. An actual 10 tUSDC token transfer/deposit into exchange custody.
3. Rerunning deployment fails on existing code and leaves **all exchange/token contract storage byte-for-byte unchanged**.
4. Simulated interruption after exchange code deployment but before initialization: rerun refuses that account without initializing or overwriting it.
5. Explicit replacement-account deployment reuses the existing token with its signing key omitted. The original funded exchange state and its token balance remain unchanged; its custody audit stays balanced.

The rehearsal exposed an SDK sequencing defect: default transaction submission returns `EXECUTED_OPTIMISTIC`, while dependent deployment reads use `final`. Deployment now waits for `FINAL` receipt outcomes and rejects receipt failures before subsequent steps. The successful full CLI regression includes this fix. An earlier fixture error serialized a public key as a private key; the fixture now explicitly generates/stores the real test-only key pair. No public credential was involved.

Deployment is cross-account and **not atomic**. An interruption can leave deployed token/code/storage and consume local or, if separately approved, testnet gas. Do not blindly rerun, remove code, reset state or automatically initialize an interrupted account. Inspect finalized state/receipts; use the replacement procedure in [OPERATIONS.md](OPERATIONS.md). The local rehearsal does not authorize doing so publicly.

## Approved implementation-agent review — completed, not independent

The user's explicit approval supersedes the previous independent F4 sign-off requirement only. [F4_REVIEW.md](F4_REVIEW.md) is the review record; experimental economic behavior remains unchanged and public release still requires separate approval.

- [x] Implementation-agent identity/non-independence and reviewed source/artifact hashes recorded.
- [x] Signed index truncation, carried remainder, partial-close dust, payer exhaustion, liquidation and custody conservation reviewed against the separate integer-reference tests; three explicit assurance tests added.
- [x] Owner/oracle authority, epoch/revision replay, expiry, fallback, last-fill manipulation and clock/RPC failure assumptions reviewed with retained limitations.
- [x] Legacy Market/root layout incompatibility, key custody, distinct deployment roles, final receipts and interrupted/replacement recovery reviewed. No full archived-state dump/migration certification claimed; mandatory fresh deployment retained.
- [x] Findings, severity and dispositions recorded; relevant local regressions passed. No new blocking defect identified in this scope; no release, public spending or trading approval implied.

Remaining material risks: unaudited custody/upgrade authority, trusted oracle/RPC and local clocks, manipulable sparse last-fill signals, integer residual rates, collateral-capped payouts/counterparty closure, simplified MODEL_PAPER assumptions and no production strategy/spot integration. Rust still reports upstream `wasmparser 0.78.2` future incompatibility. Public deployment, real wallet validation and independent sign-off were not performed.
