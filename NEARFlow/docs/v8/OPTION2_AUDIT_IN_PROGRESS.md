# V8 Option 2 — read-only investigation checkpoint (unfinished)

## Authorization / status

The user approved **Option 2 in principle**: investigate an existing Rhea/Ref testnet pool and compatible collateral instead of requiring the custom faucet token. The user explicitly withheld permission to deploy, create pools, add liquidity, swap or spend tokens. This checkpoint preserves the investigation when the user requested commits/publication; it is **not a completed compatibility review, approved token selection or V8 completion**.

No signer, credential file, deployment account or active environment configuration was changed. All network calls were public read-only views or public price-feed reads. V8 remains disabled/unchecked.

## Saved observations

- [`option2-discovery.json`](option2-discovery.json): existing pool inventory at finalized testnet block **277325802**, hash `9mNhTNrnoFLhwv4NtdrShEhusHqrGu5UkELgVRMFv1bW`. Scanned 2,952 pools; 2,084 include `wrap.testnet`, with 788 distinct paired tokens. Metadata was fetched for **27 USD/DAI-named token contracts**, not every token. Pool kind matters: SIMPLE, STABLE, RATED and DEGEN cannot share an assumed pricing formula.
- [`option2-account-inspection.json`](option2-account-inspection.json): code hashes, downloaded-Wasm SHA-256/export inventories, public access-key permissions, metadata and storage views at that discovery block. Public access keys are not signing secrets. Source/authorization verification remains incomplete; an export named `mint` does not alone prove its access controls.
- [`option2-selected-refresh.json`](option2-selected-refresh.json): selected pool/token/venue rechecks at finalized block **277328053**, hash `CweHXY57XT1pLSjP2gMH8gxxS8Fu12We7NhBwRXodUH`, **2026-11-12 06:50:19 UTC**. Separately timestamped independent feed reads follow that block; they are not an atomic chain oracle observation.

RPC used for the pinned discovery/refresh: `https://rpc.testnet.fastnear.com`. The initial default public RPC hit HTTP 429; that interrupted attempt is not treated as a complete scan. Queries used explicit block hashes, not a mixed-height reserve snapshot. These records are historical, not current liquidity promises.

## Concrete candidates checked so far

Venue: **`ref-finance-101.testnet`**. Spot asset: **`wrap.testnet` (wNEAR, 24 decimals)**, corresponding to the existing NEAR perp's base exposure. Each collateral below currently reports **6 decimals**.

| Pool | Collateral token | Kind / fee | Refreshed reserves (human token units) | Findings |
|---|---|---|---|---|
| 2022 | `usdcc.ft.ref-labs.testnet` (`b-USDC`) | DEGEN / 5 bps | 2,370.72955656 wNEAR / 16,617.291023 collateral | All six attempted quote views reject with **`E129: Degens expired`**. Large reserves do not establish executable liquidity; do not apply a simple-pool formula or repair its oracle without approval. |
| 2642 | `usdc.orderly.testnet` (`USDC`) | SIMPLE / 30 bps | 25.30188054 wNEAR / 74.118956 collateral | Both-direction quote views succeed, but spot/index discrepancy and thin depth are material. |
| 2926 | `musdc.heliquant.testnet` (`mUSDC`) | SIMPLE / 30 bps | 4.73003713 wNEAR / 18.468502 collateral | Both-direction quote views succeed; extremely thin. Its marginal reserve price is about 3.9045 collateral/wNEAR, outside the existing 3% independent-index guard at the sampled reference. |
| 2939 | `usdc.parry.testnet` (`USDC`) | SIMPLE / 25 bps | 13.30023268 wNEAR / 45.802936 collateral | Both-direction quote views succeed. Reserves changed during the investigation: its refreshed marginal price is about **3.44377**, not the earlier ~2.93741. This illustrates why old pool observations cannot authorize execution. |

There are **18 successful quote views** across the three simple pools and **6 rejected views** for the DEGEN pool in the selected refresh. Successful simple-pool outputs match integer constant-product arithmetic with the recorded fee. They are view quotes, **not evidence that a signed transfer/swap/output/refund chain succeeds**.

The refreshed independent feed samples are Coinbase 3.5081, Binance 3.5130 and KuCoin 3.5119; the existing oracle's three-source median would be **3.5119 USD/NEAR**, subject to its freshness/divergence rules. These test tokens are not proven USD-backed assets. Reserve ratios cannot be substituted for an independent oracle or assumed to prove a USD peg.

Pool 2939's refreshed marginal ratio is within 3% of that sampled reference, but this does **not** establish full compatibility: a 20-bps curve-impact allowance limits a buy to roughly **0.0266 NEAR** before output dust, whereas the existing perp's 1-USD minimum order needs roughly **0.2847 NEAR** at that reference. Its two spot fees alone total 50 bps, versus a 20-bps/hour funding cap and the loop's one-hour forecast bound, before perp fees, gas, repair or reserve. No positive-net-carry entry is established. The 20-bps example is the tested policy setting, not an immutable protocol-wide slippage cap; raising it is not an approved fix.

## Permissions and storage findings to date

- Venue metadata reports **version 1.9.19**, state **Running**, `wnear_id = wrap.testnet`, owner `reflabs.sputnikv2.testnet`, four guardians and an empty frozen-token list at the discovery snapshot. It also exposes owner/guardian control, fee/freeze changes and upgrade methods. Three full-access account keys were observed.
- `wrap.testnet` has five full-access keys. Its current NEP-141 storage minimum is **0.00125 NEAR**. It must not be represented as immutable or free of administrator risk.
- Each inspected collateral has full-access upgrade keys. `usdcc.ft.ref-labs.testnet` and `usdc.fakes.testnet` additionally expose decimal/name/mint/burn mutation methods. A six-decimal metadata read is a point-in-time property, not a guarantee that an administrator cannot change it.
- `usdc.parry.testnet.owner_id()` returns `parry.testnet`; it exposes owner mint/faucet controls and a public faucet. Its declared source URL was unavailable to this investigation (HTTP 404), so a reproducible source-to-deployed-code verification was **not** completed. No faucet or mint function was invoked.
- Inspected collateral storage minimums: **0.00125 NEAR** for `usdcc.ft.ref-labs.testnet`, `usdc.orderly.testnet` and `musdc.heliquant.testnet`; **0.00242 NEAR** for `usdc.parry.testnet`. The venue was registered on those tokens and wNEAR at the saved snapshots. This says nothing about registration of a future Reflex account.
- Venue account storage minimum observed: **0.00102 NEAR**; additional token-record/recovery storage requirements still need exact route review. No storage deposit/registration was submitted.
- At the discovery snapshot, venue FT balances covered the sum of reported pool reserves for the inspected assets. This is a read-only consistency check, not a full venue solvency audit or proof of an eventual output transfer.

## Existing perp compatibility — preliminary only

`contracts/exchange/src/math.rs` uses six-decimal collateral and base size with 1e18-scaled prices. Another genuine NEP-141 **six-decimal** collateral can fit those integer operations without rewriting funding, capped bilateral P&L or liquidation formulas. Token identity is immutable constructor configuration; existing deposits cannot be converted by replacing an address.

Economic compatibility is separate: `lib.rs::collateral`, `views.rs::get_price`, client collateral configuration and the publisher's independent NEAR/USD feeds presently assume nominal USD collateral. A token symbol does not validate that assumption. A mutable-decimal token, unsupported transfer behavior, depeg or materially divergent testnet price must block new risk rather than silently change the oracle to the swap pool.

Actual wNEAR custody is **not implemented** by the existing collateral-only Strategy record. It requires independently conserved base inventory and pending swap/output/refund accounting, exact 24-to-6 exposure conversion with retained dust, on-chain delegated policy, bounded recipient/venue/pool authority and fixed-owner settled base-asset exits. A wallet swap is not a substitute for those changes.

## Still to finish before an implementation-approval recommendation

1. Complete exact token authorization/source review, transfer behavior and route-specific token/venue storage requirements; do not claim authorization solely from method names.
2. Resolve liquidity, independent-index and collectible-net-cost failures. Re-read quotes/frozen state/code hashes/metadata before any later activation. No unconditional deployable token/pool combination is recommended by this draft.
3. Produce the final exact contract/adapter/permission and signed Sandbox test plan; no production implementation is authorized by this checkpoint.
4. Prepare a **fresh-account-only** deployment manifest using the existing token, with `NEAR_TEST_TOKEN_KEY_FILE` omitted, distinct owner/oracle/executor roles, metadata/code/pool checks and a separately approved funding/storage budget. No new exchange account is selected/provisioned here. Do not overwrite or mutate any initialized/funded deployment.
5. Obtain implementation approval, then satisfy the independent live-execution/S1–S3/D1 gates and separately request deployment/spend approval. Do not create pools, add liquidity or call swaps to make this audit pass.
