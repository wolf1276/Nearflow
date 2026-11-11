# NEARFlow operations

## Local validation

From `client/`: `npm run typecheck`, `npm run lint`, `npm test`, `npm run contracts:test`, `npm run test:sandbox`, `npm run build`.

The Sandbox test uses NEAR Sandbox **2.14.0** and patches `.testnet` account names only in the local chain so it can execute the same testnet-restricted Wasm. It tests actual token resolver refunds and failed withdrawal recovery; local keys are generated/test-only. It never contacts public testnet to transact.

## Fresh public testnet deployment

Provision a funded exchange account, separate funded oracle account, and optional faucet-token account using NEAR tooling. Back up their keys outside the repository. Contract and token account names must end with `.testnet`; the oracle may be any funded NEAR testnet account. Prefer new dedicated accounts; do not reuse production credentials.

1. Copy `.env.local.example` to `.env.local`. Set `NEXT_PUBLIC_NEAR_CONTRACT_ID`, `NEXT_PUBLIC_NEAR_USDC_ID`, and paths to credential JSON files (`account_id`, `private_key`). The file paths are script-only, never `NEXT_PUBLIC_*`.
2. `npm run contracts:build` produces `contracts/artifacts/nearflow_perps.wasm`, `nearflow_test_token.wasm` and hashes. Use these optimized artifacts, not raw compiler output.
3. `npm run deploy:testnet` deploys the optional token and exchange, registers active markets, registers the exchange with the token and registers the oracle as keeper. It refuses an initialized exchange. To use an existing six-decimal test token, omit `NEAR_TEST_TOKEN_KEY_FILE` and supply that token ID.
4. `npm run dev:oracle` runs the feed publisher. `npm run dev:keeper` runs matching/funding/liquidation. `--once` is supported: `npm run dev:oracle -- --once`.
5. Run the app with the same public account IDs. `/api/health` reports contract connectivity; `/api/ready` returns 200 only when the contract and all listed markets are unpaused, token configuration agrees and oracle data is fresh.
6. Invoke the provided token's `faucet` method from each test trader account. It mints 1,000 tUSDC per call and is not real USDC. Register token/exchange storage in the collateral dialog; web wallets may redirect after each registration.
7. Deposit from two accounts and place opposite limit orders within 5% of the oracle. Market tickets use a 1% protective IOC limit. Inspect positions, fills, custody audit and on-chain events.

Deployment requires real testnet NEAR for gas/storage; this repository intentionally contains no funded accounts or deployment secrets. Allow sufficient NEAR on the exchange for global history and Wasm storage in addition to individual registrations.

## Wallet confirmations

MyNearWallet may navigate away for each transaction. Return parameters are checked against the pending account and receiver; every receipt is inspected. A transfer-call refund is not reported as a deposit. A failed token withdrawal restores the vault balance and is not reported as paid out. If confirmation times out, check NEARBlocks before submitting again.

## Failure responses

- **Oracle stale:** new execution, closing and liquidation stop. Restart the authorized publisher, verify independent feeds and RPC time. Do not insert a browser spot-price fallback. Funding stops accruing after the old price expires.
- **Venue paused:** owner can call `set_paused` with exactly 1 yoctoNEAR. Available-balance withdrawals, cancellations and oracle-priced reductions/closes remain enabled. Paused venues are not ready for new exposure.
- **Custody mismatch:** the keeper stops when `audit().balanced` is false. Pause new exposure and investigate receipts/state; never paper over ledger differences by changing displayed balances.
- **Unmatched order:** inspect expiry, price/limit band, free collateral reservation, remaining OI/position capacity and whether the only counter-order belongs to the same account. IOC cancels its remainder; a standing order may need cancellation/replacement after a price move.
- **Keeper down:** bounded automatic matching still runs during order submission. Views estimate funding, but expired-order cleanup and liquidation require transactions. Run the keeper continuously and monitor its funded balance.

## Security boundary

This is unaudited testnet software with a trusted publisher, capped bilateral payouts, bounded history, and custody-account upgrade authority. Do not use real assets or advertise uncapped PnL/cross-margin semantics. Full archive indexing, decentralized price verification and audited production governance are out of scope for this testnet implementation.

Dependency scans should be repeated before deployment. The code uses Ed25519 NEAR account authorization; any remaining transitive low/moderate dependency advisories are not evidence of a production security audit. Build and run tools against trusted input only.
