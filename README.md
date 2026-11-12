# Reflex Perps

**Perpetual trading that adapts to the market.**

Existing NEAR perpetuals desk for **testnet and test funds only**, extending into a controlled adaptive-funding / autonomous delta-neutral hedge product. The NEAR migration is complete; preserve the exchange and primary Trade terminal.

The [roadmap](todo.md) and [architecture](ARCHITECTURE.md) preserve the existing DEX. Funding and a [real isolated testnet vault custody core](docs/VAULT_DESIGN.md) are implemented and locally verified: actual test-token deposits, owner-only allocation/pause/withdrawal and failed-payout recovery. Isolated owner-signed strategy trading and local independently persisted PAPER hedge execution/risk/replay are now implemented; run `cd client && npm run vault:paper` or `npm run test:phase2`. See [Phase 2 evidence and limitations](docs/PHASE2_ASSURANCE.md). The [local finalized-funding → bounded PAPER loop](docs/PHASE3_ASSURANCE.md) is also implemented (`npm run test:loop`), including an actual finalized Sandbox-to-PAPER integration. Genuine autonomous two-leg execution/on-chain feedback and the integrated Autopilot UI remain gated/unimplemented. Deterministic simulations are internal research infrastructure—not a standalone Stress Lab page. Existing NEARFlow directory/contract/UI identifiers have not yet been rebranded in code.

## Implemented

- One Rust contract for NEP-141 custody, order escrow, matching, positions and settlement.
- Wallet-authorized limit, post-only, IOC and reduce-only orders; monotonic nonces and expiries.
- Price-time matching, self-trade prevention, initial/maintenance margin checks and open-interest caps.
- Oracle-priced partial/full closes, permissionless liquidation and zero-sum funding.
- Token storage registration, transfer-call deposits, and asynchronous withdrawal failure recovery.
- MyNearWallet integration, redirect confirmation, finalized JSON-RPC APIs, account history and lifetime leaderboard.
- Six-decimal collateral/base sizes, 18-decimal prices and wide intermediate integer math.
- Test token, Wasm build pipeline, deployment, oracle and keeper scripts.
- Real isolated strategy custody within the same exchange ledger, fixed-owner payouts, paid bounded storage, replay-safe withdrawal callbacks and wallet-call helpers.

## Settlement model — read before trading

This is an **isolated, bilateral, collateral-capped perpetual** implementation, not an uncapped cross-margin exchange. Each match opens a pair with both traders' margin in escrow. Either party can close the pair, settling both sides at a fresh on-chain oracle price. Profits cannot exceed the counterparty's remaining margin, even through price gaps. Positions can be partially closed; reduce-only orders close owned opposing lots at the oracle, rather than resting in the order book.

Opening fees are 3 bps per side. Liquidations charge up to 50 bps of current notional from the liquidated side's remaining equity, split between the liquidator and insurance. The oracle is an explicitly trusted publisher. No administrator withdrawal or user balance override exists, but custody-account full-access keys can redeploy code: secure those keys.

## Run

Node 22+, Rust with `wasm32-unknown-unknown` installed.

```sh
cd client
npm ci --legacy-peer-deps
cp .env.local.example .env.local
npm run dev
```

Open `/trade/NEAR-PERP`. Without deployment configuration or fresh oracle prices, the desk disables new exposure and reports the cause; it never substitutes an external spot price for settlement.

## Verify

```sh
cd client
npm run typecheck
npm run lint
npm test
npm run contracts:test
npm run test:sandbox
npm run build
```

`test:sandbox` builds both Wasm contracts, downloads/runs a pinned local NEAR Sandbox 2.14.0, and verifies real NEP-141 refunds, fills, settlement, liquidation and both withdrawal outcomes. This uses local test keys only; it does not deploy to public testnet. Wasm is canonicalized/lowered with Binaryen for NEAR compatibility; deploy `contracts/artifacts/*.wasm`, not unprocessed compiler output.

## Deploy to NEAR testnet

Create and fund separate `.testnet` contract, oracle and optional test-token accounts with NEAR tools/MyNearWallet. This repository does not contain funded accounts or private keys.

**Fresh exchange deployment is mandatory for the current funding and strategy-custody state layouts.** Do not deploy over incompatible initialized/funded state. Close/settle/withdraw under the original code, then use a new contract account and explicit deposits; see [funding compatibility policy](docs/FUNDING.md).

1. Set public account IDs and local credential file paths in `client/.env.local` (see example).
2. Run `npm run contracts:build`, then `npm run deploy:testnet`. It refuses an already initialized deployment.
3. Run `npm run dev:oracle` and `npm run dev:keeper` in separate processes.
4. Check `/api/ready`. A ready venue requires matching token configuration, an unpaused contract and fresh prices for every listed market.
5. Use the test token's `faucet` method from your account, register storage in the collateral dialog, then deposit test tokens.
6. Place opposite orders from two different accounts. Closes/liquidations require a fresh oracle but do not require a counter-order.

No public deployment has been performed by these changes. Never put credential contents in `NEXT_PUBLIC_*` variables.

## Boundaries

- Testnet only; custody cap at most 10,000 test USDC; leverage at most 10x.
- At most 8 markets, 1,000 registered accounts, 256 active orders/pairs, and 16 orders/32 positions per account.
- Latest 32 order records per account and latest 512 global trade/funding events are retained. Lifetime totals remain on-chain; historical windows are explicitly bounded. No fabricated transaction hashes or equity snapshots.
- Oracle: median of at least two independent feeds; reject >3% source divergence; prices expire after 60 seconds. A publisher outage pauses execution and funding accrual past freshness, but free-collateral withdrawals and cancellations remain available.
- No stop/trigger orders, cross-margin netting, permissionless price oracle, production governance, or external indexer is claimed.
- Not security-audited. Dependency audit findings and custody-key/oracle trust must be reviewed before any real-money use.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md).
