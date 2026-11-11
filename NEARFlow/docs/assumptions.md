# Reflex Perps — inspected assumptions and Phase 0 gate

## Existing exchange (before Reflex extension)

- Market model: **MATCHED_ORDERBOOK**, isolated bilateral lots. `trading.rs::execute_match` creates a long and a short with equal size. `views.rs::open_interest` returns the same aggregate size for both sides. There is no LP counterparty or vAMM inventory.
- Authoritative ledger: `contracts/exchange/src/lib.rs::Exchange`; accounts, order escrow, pair margin, funding checkpoints and asynchronous token withdrawals all belong to this one contract. Do not create a second collateral/position ledger for Reflex.
- SDK: near-sdk **5.28.0**; existing token contract uses near-contract-standards 5.28.0. Preserve these versions.
- Price: independent trusted publisher via `publish_price`. The existing oracle script requires at least two of Binance, Coinbase and KuCoin; rejects >3% divergence. Contract prices are 1e18 USD, positive and <=1e27, monotonically timestamped, <=10 seconds old on ingress, and usable for 60 seconds. Last execution is separate from the independent index.
- Collateral: one immutable allowlisted six-decimal NEP-141 test token; deploy script checks metadata. The supplied faucet token is test money, not real USDC.
- Margin: isolated paired escrow, max 10x leverage. Payouts are capped by counterparty escrow, not uncapped cross-margin claims. Either party can close the bilateral lot. Reduce-only executes owned opposing lots at oracle price. Pause blocks new risk but permits oracle-valid closes/reductions, cancellation and unlocked withdrawal.
- Funding: one signed price-per-base cumulative index, opposite transfers within each pair, lazy checkpoints and fractional remainder. Existing premium-derived rate cap is 10 bps/hour. Existing `publish_price` is the extension point; controller updates must first accrue the old rate/index.

## Interfaces and extension points

| Need | Existing method/module | Extension |
|---|---|---|
| Market/price | `get_market`, `get_markets`, `get_price` | derive premium signal from recent matched execution, not OI difference |
| Funding accounting | `math.rs::funding_index`, `trading.rs::apply_funding` | retain existing lazy settlement and remainders |
| Controller authority | owner/oracle checks | owner-configured algorithm; deterministic on-chain output, never a caller-provided rate |
| Orders | `place_order`, `cancel_order`, `close_position` | unchanged wallet-signed execution |
| Health/exit | `positions`, `account_health`, `liquidate` | preserve risk and collateral checks |
| Lab | new `packages/sim` | deterministic, no custody mutation |
| Guardian | new `packages/risk`, paper adapter | PAPER only by default; no token or withdrawal authority |
| HTTP | `client/app/api/[...path]/route.ts` | simulation/read-only proposals only; real orders stay wallet-authorized |

## Evidence and blocker

Phase 0 local baseline: 41 Rust tests, 27 TypeScript tests, clean lint/typecheck/build and a real NEAR Sandbox 2.14.0 receipt-chain smoke test pass. Sandbox covers token registration/deposit, two-account matched long/short, finalized API positions/fills, PnL/funding, close, cap refund, liquidation, failed withdrawal restoration and successful withdrawal. Wallet action serialization and redirect-result logic are unit-tested; an interactive wallet signing session has not been claimed.

**Public testnet verification is blocked:** `.env.local` is absent and `.env.local.example` contains blank contract/token IDs and credential paths. No public deployment address, available real USDC contract or successful public transaction can be inferred. Do not report Sandbox transactions as public testnet activity. The operator must provision/fund accounts, deploy and run the documented manual wallet smoke test before a live submission demo.

This gate permits isolated, offline/testnet-build extension development on the verified local exchange, not a claim of public deployment or production readiness. Autopilot remains PAPER. NEAR Intents/live spot integration is not implemented or implied.

## Reflex hypothesis for this market

Use premium EMA and a normalized premium response, not pool capacity/skew. The matched-orderbook Reflex experiment is separately labeled; no hyperbolic pool-skew advantage is claimed. The same exogenous paths, seeds, fees and agent response are used for both arms. Sensitivity=0 is mandatory and can falsify an improvement claim.
