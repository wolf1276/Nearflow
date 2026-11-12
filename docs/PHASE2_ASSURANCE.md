# Phase 2 — local strategy accounting and PAPER execution

## Scope and disposition

Implemented the V0–V7 local/PAPER path. V8's deny-by-default execution gate is implemented, but genuine execution remains **blocked**, not passed: no approved spot venue, delegated contract authority, signed two-leg integration, S1–S3 completion or dedicated public deployment exists. This is not permission to spend operator funds or deploy. No real automated strategy trades were performed.

The implementation-agent reservation review is `V0_RESERVATION_REVIEW.md`. It is not independent assurance. Phase 1/F4 hashes describe their historical checkpoint; they do not certify these new storage-incompatible strategy extensions. The larger Phase 3 feedback loop, Phase 4 UI/API and Phase 5 integrated security gate remain separate work.

## Implemented map

| Task | Implementation / evidence |
|---|---|
| V0 | Optional strategy attribution on orders and each pair side; existing engine routes escrow, refund, margin, funding, close and liquidation through the selected isolated book. No second spendable balance. Manual paths cannot consume the owner's strategy positions. |
| V1 | `packages/adapters/{types,paper}.ts`: independently persisted spot/perp instances, virtual assets, quote identity/TTL/market/depth/fees/slippage, cumulative partial fills, pending/rejected/cancelled status. Every receipt is `null`, never a fake chain transaction. |
| V2 | `packages/risk/{policy,state-machine}.ts`: strict versioned schema, canonical immutable policy hash, owner confirmation, explicit lifecycle and open/reduce/close flags. Bounds cover gross, delta/time, reserve/margin, slippage, turnover, costs, cooldown and retries. |
| V3 | `packages/vault/{opportunity,sizing}.ts`: integer capacity sizing; conservative funding capped by payer collateral and collectible horizon; nonpositive basis assumption; entry/exit/repair/reserve costs; collateral/depth/divergence checks. Positive gross funding alone does not authorize entry. |
| V4 | `services/guardian/guardian.ts`: persist stable intent before submit; query the independent venue by ID on restart/timeout; cumulative monotonic revisions; conflicting/unknown outcomes pause without blind resubmission. Only reconciled fills grow expected exposure; unexplained observation changes stop it. External reductions are logged and reconciled. |
| V5 | `packages/risk/watchdog.ts` and Guardian: actual delta/duration, funding reversal/expiry, free reserve, marked perp equity, gross and nonlinear P&L caps. Reduce surplus exposure only within policy, otherwise stop. Repair never increases a broken hedge. |
| V6 | Owner stop retains/reconciles pending orders. Close first stops submissions, cancels known pending orders, then independently proposes bounded reduce-only exits. Unknown receipts, unavailable oracle/depth or exhausted budgets block rather than invent an exit. Real settled withdrawal remains owner-signed, fixed-recipient on chain; Guardian has no withdrawal or policy/payout mutation API. |
| V7 | `packages/vault/{store,events,replay}.ts`: atomic durable journal, exclusive writers, bounded event/order capacity, hash chain, normalized snapshots/reasons/costs, redacted sensitive field names and no exception text. Replay recomputes economics, cumulative order costs and observed total venue costs (including external exits). |
| V8 | `packages/adapters/execution-gate.ts`, constructor rejection of non-PAPER/mixed adapters, existing manual wallet actions. Genuine adapters are deliberately unavailable; tests assert refusal. |

One shared adapter implementation creates **two separate durable ledgers**; it does not imply an atomic two-leg venue. Quotes use micro-USD/base and quantities micro-base, explicitly not the contract's 1e18 price scale. Strategy ID and market identity must match. All assets and funding in these adapters are virtual; nothing can credit the real exchange.

PAPER spot holds cash/inventory. PAPER perp holds isolated own margin and finite counterparty collateral. Funding transfers equal/opposite between those two margin buckets. Close P&L is capped by own margin/counterparty collateral; costs leave the virtual cash ledger into an explicit cost tally. Spot losses and capped perp profits need not offset. Marked P&L/equity/cap binding are exposed before close, not only after settlement. This is deterministic execution infrastructure, not a complete NEAR matching-queue/finality/liquidation-penalty emulator.

## Running it

From `client/`:

```sh
npm run test:phase2
npm run vault:paper                  # fresh private temporary directory, prints its path
npm run typecheck                   # includes external Phase 2 packages
npm test
npm run test:sandbox
npm run lint
npm run build
```

`npm run vault:paper -- /trusted/private/fresh-directory` persists an inspectable fixture. Existing ledgers are never reset by the CLI. It logs a net-negative skip, permitted hedge, independent fills, unilateral counterparty close, bounded residual-spot reduction and settled state. The fixture deliberately injects **no realized funding** and loses 0.20 virtual USD to execution costs. Its estimated carry is not realized profit.

To inspect/replay a saved run, load `guardian.json` with `Store<Journal>`, then call `replayDecisions(state.events, state.policy)`; `Guardian.snapshot()` checks policy/hash-chain integrity. A restarted Guardian uses the same three journal paths. Dispatching a previously sent ID only looks it up; absence does not authorize a retry. No network credentials are required.

## Persistence, archival and operator limits

- Internal single-host infrastructure only, not a distributed service or public authenticated API. The local caller/configuration is trusted; `actor` is an internal owner-confirmation parameter, **not cryptographic wallet authentication or delegated authority**. Real authority still comes exclusively from contract predecessor checks and owner wallet signatures. No full-access key is called restricted.
- Store the three files in a trusted private directory, outside served assets and Git. Each write takes an exclusive `.lock`, writes a temporary file, fsyncs, atomically renames and fsyncs the directory. A second writer refuses, rather than racing. Never edit a live ledger.
- A process crash during a locked disk transaction may leave a lock. Stop all workers, verify the process is dead, archive files/lock/temp with checksums, inspect committed state and both venue order records, then remove only the stale lock. Reopen the last committed journal and reconcile. Never clear `sent`, reset a policy, or resubmit an absent/unknown order to force recovery. A crash after intent persistence but before submit conservatively pauses even if this sacrifices liveness.
- At 4,096 events or 2,048 adapter orders, writes/new submissions fail closed. Archive **before** reaching the limit: stop opening, reconcile/cancel/unwind known pending orders, settle, export all three ledgers and checksums to private durable storage, verify replay, retain them immutable, and create a distinct new strategy/ledger. There is no silent ring eviction, automatic trimming or continuation with forgotten pending receipts. If capacity is already exhausted, operator investigation is required; do not delete records to continue.
- Checksums detect corruption, not a malicious host rewriting a journal. No recovery from lost disks, multi-host leases, autonomous scheduling, live venue finality or production key management is claimed. The caller must invoke reconciliation/watchdog with timely observations; a stopped process is not an active watchdog.
- PAPER funding observations have bounded expiry. Production funding snapshots/reconfiguration ingestion and market feedback belong to C0–C2; this CLI cannot authorize chain actions.

## Verified local evidence

- **111 exchange Rust tests**, including 13 new strategy-trading tests: partial match/cancel/close routing, same-owner book/nonce/history isolation, manual-path bypass rejection, foreign allocation rejection, escrow withdrawal/cap rejection, pause/resting-order behavior, funding/liquidation attribution, lazy effective-funding cap, duplicate-reference audit and bounded trading storage.
- **4 funding Rust tests** (preserved).
- **89 TypeScript tests**, including **23 PAPER tests** and one new wallet-helper test. Cases include all state edges, policy schema/hash/owner/permissions, conservative sizing/net economics, independent partial/pending legs, deterministic IDs, timeout-then-success/restart, unknown/conflicting/out-of-order receipts, owner stop with late fills, retry limits, unavailable venues/oracles, capped crash exposure before/after close, funding conservation, delta-duration/margin/reserve checks, event replay/redaction/capacity and genuine/mixed execution refusal.
- **3 actual-Wasm Sandbox integrations** pass, including extended vault receipt chains: owner-signed strategy order escrow/matching, forged owner and manual-close rejection, counterparty-triggered close, unchanged manual balance, fixed-owner payout and token balance versus global custody reconciliation.
- Both existing desktop/mobile Chromium funding fixtures, lint, combined client/Phase 2 typecheck and production build pass. Rebuilt Wasm and regenerated the funding calibration/feedback artifacts to preserve their source-hash checks after the attribution layout changes; equations/defaults and negative/no-adoption feedback decision are unchanged.

No public deployment, interactive wallet flow, new Autopilot browser flow, independent audit or signed genuine two-leg execution was verified. **Fresh deployment only**: Strategy/Order/Pair/Trade/Funding layouts changed; never deploy over initialized/funded V0a/F4 state. Drain under original code and obtain separate release approval for a new account.
