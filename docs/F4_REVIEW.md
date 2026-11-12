# F4 implementation-agent review

## Authorization and disposition

The user explicitly approved replacing F4's independent-review requirement with documented implementation-agent accounting/security and deployment-compatibility review, fixes and relevant regression tests. This supersedes only that F4 requirement. It does **not** authorize public deployment, operator spending, autonomous trading, incompatible upgrades or resetting funded state.

Reviewer: the implementation coding agent in this session; **not independent**. Review completed 2026-11-11 against the dirty working tree based on `01cc71aa6b49f8e5cd014ab30a75728d32dda50d`. [F4_REVIEW.sha256](F4_REVIEW.sha256) pins the source/test/configuration and optimized Wasm checkpoint; it is a content manifest, not a signed release or full repository archive. Revalidate it from `NEARFlow/` with `sha256sum -c docs/F4_REVIEW.sha256`. Later changes require relevant re-review/retesting.

**Disposition: F4 complete for this user-approved local scope. No new release-blocking defect identified within the reviewed scope.** This is not an independent audit or production/security guarantee. S3, real execution, public deployment and operator approval gates remain separate.

## Review performed

- Inspected funding parameter validation and Rust equations, authoritative controller cadence/configuration, shared freshness and market-index calculation, lazy pair settlement, matching checkpoints, partial/full close, liquidation and collateral transfer paths. Compared signed quotient/remainder behavior with the existing separate integer-reference tests and shared accounting vectors.
- Inspected owner/oracle/one-yocto checks, current-hour monotonic epochs and expected revisions. Permissionless updates derive their signals from retained opening fills and oracle state, not caller-supplied rates. Configuration and oracle updates accrue the previous index first. Configuration consumes the current epoch; neither mode changes nor replay rewrite pair history.
- Confirmed settlement clamps the signed payment to payer margin and applies equal/opposite changes. Remainders normalize on sign reversal; uncollectible excess is not booked as a receivable. Partial close settles first, floors each released margin and retains the rest; only the remaining size retains its proportional fractional funding remainder. Full close deletes the pair.
- Inspected legacy `Market` and root `Exchange` field orders directly at `01cc71a` and compared them with compatibility fixtures and current structs. Fixtures reject decoding old layouts; funded current root bytes round-trip with conserved accounting. No archived deployed-state dump was supplied: this is layout incompatibility detection, **not** a migration or archived-state recovery certification.
- Inspected deployment preflight, deploy CLI, runtime credential/finality helpers, Wasm build script and actual-CLI Sandbox test. Code/data must both be absent at one finalized snapshot; role overlap, malformed/unavailable RPC state and code-only interrupted accounts reject. Dependent reads wait for FINAL receipts. Reusing an existing token omits its deployment key. Recovery uses a new exchange account and does not modify original funded storage.

## Findings and disposition

| Finding | Severity / boundary | Disposition |
| --- | --- | --- |
| Legacy Market and Exchange storage is incompatible; full archived-state migration is not demonstrated. | High if deployed as an in-place upgrade | **Mitigated for F4** by mandatory fresh code-free/data-free deployment and fail-closed preflight. Drain/close/withdraw old custody under original code before replacement. No migration/reset permitted. Public release still gated. |
| Market checkpoint division truncates toward zero; fractional index units are not carried across price publications. | Low precision limitation | **Retained and documented.** Error is less than one 1e-18 USD/base index unit per checkpoint, toward zero for either sign; this is not partition-independent accrual. Added explicit two-sign checkpoint-bound test. |
| Partial close discards the closed share of a fractional funding remainder; full close discards remaining fractional dust. | Low precision limitation | **Retained and tested.** The discarded claim is below one collateral atom per close; integer released margins plus retained margins conserve. Added explicit positive/negative near-one-atom remainder tests across partial then full close. This is not a promise of zero cumulative dust over unlimited closes. |
| Sparse last-opening-fill signals can be manipulated; oracle publisher and RPC/clocks are trusted; small rates may persist through quantization. | Material economic/trust limitations | **Retained for the experimental local scope**, with freshness/divergence/absolute caps and F3 no-adoption decision unchanged. Not evidence of manipulation resistance or live-market improvement; later security/release review remains required. |
| Deployment is non-atomic; a full-access key or concurrent writer can bypass/race client-side preflight. | High outside trusted operator assumptions | **Not solved by the CLI.** Use dedicated operator-controlled roles, trusted RPC, exclusive deployment access and inspection/replacement after interruption. No credentials accessed and no public deployment authorized by this review. |
| Upstream `wasmparser 0.78.2` future-incompatibility warning remains. | Dependency maintenance | **Deferred to broader dependency/release review**, not concealed by passing local tests. No clean-install/dependency/secret-scan certification is made here. |

No contract or deployment runtime logic changed in this review. Three assurance tests were added: signed checkpoint truncation bounds, partial-close fractional dust for both signs, and full-close replay rejection. The first dust-test run exposed reused mock storage between separately constructed fixtures; the test now uses one exchange and sequentially opened pairs. Final full exchange regression passes.

## Re-executed evidence

Commands from `NEARFlow/` unless prefixed with `cd client`:

| Command | Result |
| --- | --- |
| `cargo test --locked --manifest-path contracts/exchange/Cargo.toml` | **98 passed**, including the three added tests |
| `cargo test --locked --manifest-path packages/funding/Cargo.toml` | **4 passed** |
| `cd client && npm test` | **65 passed**, including research provenance and exact replay checks |
| `cd client && npm run typecheck` | Passed |
| `cd client && npm run lint` | Passed |
| `cd client && npm run test:e2e` | **2 passed**, desktop/mobile Chromium funding fixtures; no wallet signing |
| `cd client && npm run test:sandbox` | **3 passed**, builds actual Wasm; exchange/keeper, vault and actual deploy/recovery CLI receipt chains |
| `cd client && npm run build` | Passed |

Sandbox/build/browser/TS runs preceded the final Rust test-only additions; no runtime source changed afterward. The exchange suite was rerun after those additions. Wasm hashes in the manifest identify the artifacts exercised in Sandbox, not a public deployment.

Not performed: independent audit, full archived-state migration rehearsal, fresh dependency installation/scans, public RPC/wallet transactions, empirical production calibration, real spot execution or autonomous hedge execution. All keys used by Sandbox were generated local test credentials; operator funds and funded public state were untouched.
