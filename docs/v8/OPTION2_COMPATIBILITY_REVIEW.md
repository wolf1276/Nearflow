# V8 Option 2 — compatibility decision and implementation prerequisites

## Decision: BLOCKED — no approved executable combination

The permitted read-only assessment is concluded for the audited candidates. **V8 itself is not complete.** No candidate is recommended for activation under the existing policy, and no contract/adapter implementation or public spending is approved by this report.

This supersedes the unfinished checkpoint's selection discussion, not its historical evidence. The user's restrictions remain: no deployment, pool creation, liquidity addition, signed swaps or token spending without separate approval. No credentials or signing keys were loaded.

## Latest checks

[Latest read-only evidence](option2-latest-check.json) is pinned to finalized testnet block **277330507**, hash `5kKtXYVAUo9ZYpUTwotMjkoZZx3QUYHFFSCvgMgxemgR`, timestamp **2026-11-12 07:14:15 UTC**. Queries used `https://rpc.testnet.fastnear.com` and explicit block hashes. The venue still reports 2,952 pools. Price feeds are separately timestamped, not atomic with that block.

Venue: `ref-finance-101.testnet`. Spot asset: `wrap.testnet`, **24 decimals**. All four collateral candidates below currently report **6 decimals**.

| Pool | Collateral | Kind / fee per swap | Latest relevant result |
|---|---|---|---|
| 2022 | `usdcc.ft.ref-labs.testnet` | DEGEN / 5 bps | Both refreshed quote directions still reject with **E129: Degens expired**. No executable quote. |
| 2642 | `usdc.orderly.testnet` | SIMPLE / 30 bps | 25.30188054 NEAR / 74.118956 collateral; quotes succeed, but price/depth and costs fail the intended entry constraints. |
| 2926 | `musdc.heliquant.testnet` | SIMPLE / 30 bps | 4.73003713 NEAR / 18.468502 collateral; successful quotes do not establish adequate hedge depth. |
| 2939 | `usdc.parry.testnet` | SIMPLE / 25 bps | 13.33658358 NEAR / 45.688329 collateral; approximately 3.42579 collateral/NEAR marginal reserve ratio. Potential structural integration candidate only, **not an approved deployable strategy**. |

Six refreshed simple-pool quote outputs match the exact integer constant-product formula. Two refreshed DEGEN quote calls reject. These are **view results, not successful swap receipts**.

### Why changing collateral does not finish V8

1. **No positive net-carry entry is established.** The three simple pools charge 25–30 bps per spot swap: approximately 50–60 bps for entry and exit at comparable notional. Existing funding is capped at **20 bps/hour**, and the loop's forecast is bounded to one hour. Perp fees, price impact, gas, repair and reserve costs worsen the result. The current conservative evaluator must decline; raising the horizon or suppressing exit fees merely to force entry is not approved.
2. **The tested low-slippage policy cannot size a minimum perp hedge in the closest-price pool.** A 20-bps curve-impact allowance limits pool 2939's spot buy output to about **0.026673 NEAR** before output dust. At the separately observed ~3.525 USD/NEAR reference, the existing 1-USD minimum perp notional needs about **0.283688 NEAR**. This is an example policy setting, not a protocol-wide immutable slippage limit; it must not be raised silently. Pools 2642 and 2926 have analogous depth limits, approximately 0.050604 and 0.009460 NEAR.
3. **The apparent lower-fee alternative is unavailable.** Pool 2022's DEGEN rate inputs are expired. Reserve size or a constant-product estimate cannot substitute for a working DEGEN quote. Updating those rates is a transaction and was not attempted.
4. **Token trust is not proved by its symbol.** The existing six-decimal ledger can conserve another six-decimal NEP-141 asset, but its USD interpretation still assumes nominal one-dollar collateral. None of these test tokens is established as USD-backed. Administrator upgrade/mint/metadata powers and possible depeg remain explicit trust inputs.
5. **Real authority and base custody are absent.** Existing strategy methods are owner-signed perp actions. They do not implement bounded autonomous spot spending, wNEAR custody, authenticated output attribution, or restricted executor authority.
6. **Release evidence cannot be fabricated.** S1–S3/D1 prerequisites and signed genuine two-leg receipts/balance/restart evidence remain outstanding. Public transactions are expressly not authorized.

The earlier inventory covered 2,952 pools and metadata for 27 USD/DAI-named token contracts, not every paired token or every possible route. This is a negative result for the audited candidates, **not a proof that no suitable NEAR venue can ever exist**. Future liquidity/fees/code may change; all eligibility reads must be repeated before any activation.

## Permissions and storage disposition

Historical account/code/export/storage evidence is in [option2-account-inspection.json](option2-account-inspection.json) and [option2-selected-refresh.json](option2-selected-refresh.json). The latest check re-read token metadata and storage minimums, not a full new bytecode authorization audit.

- Venue owner: `reflabs.sputnikv2.testnet`; four guardians and three full-access keys were observed. Owner/guardian fee/freeze/upgrade controls remain a trust boundary.
- wNEAR: five full-access keys observed; minimum token storage **0.00125 NEAR**.
- `usdc.parry.testnet`: owner view returned `parry.testnet`, one full-access key observed, faucet/mint controls exported; minimum token storage **0.00242 NEAR**. The declared source URL returned 404 during investigation. A reproducible source-to-deployed-code match and full transfer/permission verification were **not** completed.
- `usdc.orderly.testnet` and `musdc.heliquant.testnet`: minimum token storage **0.00125 NEAR**; full-access upgrade keys and mint entrypoints observed. Entrypoint names alone do not certify authorization or fee-free transfer behavior.
- `usdcc.ft.ref-labs.testnet`: minimum token storage **0.00125 NEAR**; full-access key and mint/burn/decimal mutation entrypoints observed. A current `decimals = 6` read is not an immutable guarantee.
- Ref account-storage minimum observed earlier: **0.00102 NEAR**. Exact additional token/recovery storage depends on the chosen swap/output route and remains unapproved. Token registration of the existing venue is not registration of a future Reflex account.

No storage registration or transfer-behavior transaction was performed. Successful receipt-chain behavior cannot be called verified under the no-spend restriction.

## Proposed changes if a compatible pair and implementation plan are approved

These are proposed changes, not implemented APIs or an activation promise.

### Contracts

| Module | Required bounded change |
|---|---|
| `contracts/exchange/src/lib.rs` | Keep immutable selected collateral identity and fixed-owner payouts. Add only an explicitly approved base-token/venue/pool configuration; reject all arbitrary receiver/token/route execution. Validate six-decimal collateral and approved code/asset configuration in deployment preflight, not by trusting a token symbol. |
| `model.rs`, `strategy.rs` | Persist owner-confirmed real-execution policy revision/hash, exact executor binding, nonce/epoch/permissions, limits, wNEAR inventory, reserved/in-flight asset liabilities and action status. Keep collateral escrow and base custody distinct, with no duplicate spendable allocation. Closing must reject nonzero base inventory/dust or pending callbacks. |
| `trading.rs` | Restricted strategy entrypoints reuse the existing engine and its book attribution; enforce actual strategy reserve/margin, direction, gross/delta/time, turnover, slippage, freshness, cost, cooldown/retry and policy/epoch/nonce constraints. Existing owner-only methods must not become bot-accessible unrestricted spending. |
| Approved spot execution module | Reserve exact collateral before a single fixed-pool swap. Verify the actual Ref output, unwrap and callback/refund semantics first. Output credit must come from authenticated actual custody/receipt evidence, never a caller quote or a Guardian success assertion. Unknown outcomes block resubmission. This route/receipt ABI is still a blocking design review item. |
| Private callbacks / owner exits | Authenticate predecessor and unique action/strategy, support failed/duplicate/out-of-order receipts and same-strategy recovery. Owner can stop new actions while receipts remain visible; only settled assets can leave, always to the fixed owner. No automated arbitrary withdrawal or generic cross-contract call. |
| `views.rs` / audit | Expose each leg's real asset units, pending actions, policy/nonce and settled/free versus encumbered amounts. Check collateral and wNEAR custody separately; never count a spot asset as both free collateral and inventory. |

Six-decimal collateral preserves the current notional/funding/capped-P&L/liquidation integer scale. wNEAR uses 24 decimals: **one six-decimal base-size unit equals 10^18 raw wNEAR units**. Conversion must retain remainder as same-strategy inventory; no dust discard, rounding into a larger hedge or conversion through JavaScript `Number`.

The current `collateral()`/`get_price("USDC")`/client configuration assume nominal USD. Correct token identity and risk labeling are required; an unbacked test token must not be presented as issuer-authenticated USDC. Do not replace independent NEAR/USD inputs with the same swap pool to make a basis/divergence check pass.

### Adapters / service

- Add genuine per-leg adapters only for the reviewed contract/asset/pool ABI; separate native precision, quote TTL/depth/fee/slippage and actual receipt/finality states from PAPER.
- Propagate explicit execution modes; never cast a real adapter to `PAPER`, invent transaction hashes, or credit virtual balances from public funding reads.
- Enforce fixed-recipient owner/token registration, current approved metadata/code/pool state and policy hash before each action. Reconcile cumulative fills and actual venue/exchange custody before repair/retry.
- A full-access account key is not restricted delegation. The exact NEAR key receiver/method/deposit/gas constraints and on-chain executor binding must be reviewed and adversarially tested before installation. Off-chain budget checks alone are insufficient.

## Fresh deployment preparation — no account provisioned

A non-executable [deployment proposal](fresh-exchange-proposal.json) records the required missing inputs and prohibitions. It contains **no selected live collateral/pool, account ID, key path, funded amount or transaction**.

After separate implementation approval and successful local security testing:

1. Approve one exact eligible token/pool/base asset, code/metadata trust profile, route, owner policy and native gas/storage/token budgets. Re-run finalized quote/state/permission checks.
2. Have the operator provision **new distinct** exchange, oracle and restricted executor roles. Verify control without exposing keys in Git. No initialized/funded account is eligible as the new exchange.
3. Configure the selected existing collateral through `NEXT_PUBLIC_NEAR_USDC_ID`; **omit `NEAR_TEST_TOKEN_KEY_FILE`**. Never deploy the project's faucet token onto the selected existing asset or modify the venue/pool.
4. Build pinned Wasm; rerun F4 fresh-account code/data/role checks and the new compatibility/authority preflights. Updated Strategy/root layout requires a fresh deployment, not reinitialization/migration over funded state. Existing accounts and funds stay untouched.
5. Only after explicit deployment/spend approval: deploy the new exchange, register the necessary token/venue storage, create the approved market, register owner/oracle storage and strategy, and publish an independent fresh oracle. Those are future transactions, not actions performed by this review.
6. Keep real execution disabled while verifying token match, oracle/readiness, custody accounting, owner-only manual deposit/trade/close/withdraw, pause and callback recovery. Obtain separate bounded activation approval before installing/using restricted execution authority.
7. Record genuine signed two-leg receipts, actual custody balances, failed/partial execution and restart evidence. No public/live claim before this passes; do not waive S1–S3/D1.

## Required test plan

- Preserve all 111 exchange + 4 funding Rust and 107 TS regressions; tests alone are not live evidence.
- Exact 6/24-decimal vectors, one-unit/dust/min-notional boundaries, maximum accepted bounds, conservation per asset and free-versus-pending accounting.
- Wrong owner/executor/key/recipient/token/pool, arbitrary route/call injection, policy tampering, nonce/epoch replay, key deposit constraints, budget/cooldown/retry exhaustion and owner stop races.
- Storage-unregistered recipient, output transfer failure, venue-retained/lost-found assets, token/venue pause/freeze/upgrade/metadata change, malformed promises, callback forgery/replay/order and never-blind retry.
- Actual source-matched venue/asset Wasm in separately authorized local Sandbox receipt tests; mocks may test failures but cannot prove compatibility with the deployed genuine venue. Never label a mock swap as a genuine live integration.
- Minimum executable hedge, both directions/partial execution, price/depth changes, independent-index divergence, collectibility/payer cap, negative-net deliberate decline, counterparty close/liquidation and residual wNEAR unwind.
- Fresh-account-only deployment refusal, legacy funded-state preservation, owner settled exits and native gas/token accounting.
- Only after explicit public testnet spend approval: signed end-to-end receipts, custody reconciliation, restart/unknown-result recovery and wallet smoke checks. No transactions were submitted for this plan.

## What can unblock V8

An existing pool/route must pass the reviewed asset, quote, depth, independent-index and net-cost conditions, or the user must separately approve a **reviewed design/policy change**. Neither silently increasing the horizon/slippage nor subsidizing unrecorded costs is an approved solution. Venue/operator rate repair or liquidity changes are transactions and remain unauthorized.

Once that prerequisite is satisfied, the exact authority/custody route and implementation plan can be approved, implemented and tested locally; public execution still needs explicit accounts/budgets/spend approval and its receipt/security gates. **Do not mark V8 complete merely because the feasibility review now has a negative conclusion.**
