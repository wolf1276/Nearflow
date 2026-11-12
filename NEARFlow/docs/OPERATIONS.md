# Reflex Perps operations

## Local validation

From `client/`: `npm run typecheck`, `npm run lint`, `npm test`, `npm run contracts:test`, `npm run test:e2e`, `npm run test:sandbox`, `npm run build`. For browser tests install the local Chromium headless shell with `npx playwright install chromium --only-shell`; the isolated test server uses port 3100 and `.next-e2e/`, leaving an existing normal dev server alone. See [PHASE1_ASSURANCE.md](PHASE1_ASSURANCE.md) for evidence and the user-approved F4 implementation-agent review; this is not an independent audit.

The Sandbox test uses NEAR Sandbox **2.14.0** and patches `.testnet` account names only in the local chain so it can execute the same testnet-restricted Wasm. It tests actual token resolver refunds and failed withdrawal recovery; local keys are generated/test-only. It never contacts public testnet to transact.

## Fresh public testnet deployment

Current funding metadata changed Market serialization and strategy maps/counters changed root Exchange serialization. **Do not upgrade an initialized older exchange in place.** Close/settle/withdraw using its original code, then deploy to a new account; never reset funded state. See [FUNDING.md](FUNDING.md). Real isolated vault custody is implemented (see [VAULT_DESIGN.md](VAULT_DESIGN.md)); strategy trading permissions/spot execution remain proposed, not capabilities of these existing keeper/deploy scripts.

Provision a funded exchange account, separate funded oracle account, and optional faucet-token account using NEAR tooling. Back up their keys outside the repository. Contract and token account names must end with `.testnet`; the oracle may be any funded NEAR testnet account. Prefer new dedicated accounts; do not reuse production credentials.

1. Copy `.env.local.example` to `.env.local`. Set `NEXT_PUBLIC_NEAR_CONTRACT_ID`, `NEXT_PUBLIC_NEAR_USDC_ID`, and paths to credential JSON files (`account_id`, `private_key`). The file paths are script-only, never `NEXT_PUBLIC_*`.
2. `npm run contracts:build` produces `contracts/artifacts/nearflow_perps.wasm`, `nearflow_test_token.wasm` and hashes. Use these optimized artifacts, not raw compiler output.
3. `npm run deploy:testnet` deploys the optional token and exchange, registers active markets, registers the exchange with the token and registers the oracle as keeper. It requires distinct exchange/oracle/token roles and a finalized, code-free, data-free exchange account. The state read is pinned to the account query's block hash; RPC errors, missing fields and any existing code/storage fail closed, regardless of whether `status` works. An optional token signing key means fresh-token deployment and has the same empty-account requirement. To reuse an existing six-decimal test token, omit `NEAR_TEST_TOKEN_KEY_FILE` and supply that token ID. Every deployment write waits for FINAL receipts before dependent finalized reads; failed receipts stop the command. A partially deployed but uninitialized account is deliberately rejected: inspect it and follow the replacement-account recovery procedure below instead of rerunning an overwrite.
4. `npm run dev:oracle` runs the feed publisher. `npm run dev:keeper` runs matching/funding/liquidation. `--once` is supported: `npm run dev:oracle -- --once`.
5. Run the app with the same public account IDs. `/api/health` reports contract connectivity; `/api/ready` returns 200 only when the contract and all listed markets are unpaused, token configuration agrees and oracle data is fresh.
6. Invoke the provided token's `faucet` method from each test trader account. It mints 1,000 tUSDC per call and is not real USDC. Register token/exchange storage in the collateral dialog; web wallets may redirect after each registration.
7. Deposit from two accounts and place opposite limit orders within 5% of the oracle. Market tickets use a 1% protective IOC limit. Inspect positions, fills, custody audit and on-chain events.

Deployment requires testnet NEAR for gas/storage. The operator account `reflex-operator-49c6b7.testnet` was provisioned and its 14.79818 NEAR balance verified at finalized block 277264006; that is a historical observation, not a live balance promise. Its full-access credential is stored outside the repository with mode 0600, not committed or exposed to the client. No contract was deployed there and no deployment/oracle/token role is implicitly assigned by funding it. F4 local implementation-agent review is complete under explicit user approval; dedicated deployment roles, S3/release gates and separate public deployment/spending approval remain required. Allow sufficient NEAR on the exchange for global history and Wasm storage in addition to individual registrations. These client-side preflights do not protect against an independently acting full-access key or a compromised RPC; use operator-controlled keys and trusted infrastructure.

## Interrupted deployment / replacement-account recovery

This procedure was rehearsed with the actual CLI in local Sandbox; public execution still requires S3/release gates and explicit operator approval. F4's approved implementation-agent review does not grant public deployment or spending authority. Deployment across token/exchange accounts is not atomic.

1. Stop deployment/keepers. Retain failed command output, transaction hashes and credential backups outside Git. Inspect FINAL transaction receipts and finalized account code/storage/status through trusted RPC. Do not infer an empty account from a failed `status` call.
2. Do not rerun against code-bearing/data-bearing accounts, remove code, reinitialize or reset funded state. For an older initialized exchange, close/settle/withdraw under its original code before any replacement; recovery must not strand its depositors.
3. Provision a **new empty funded exchange account** with a distinct key. Update `NEXT_PUBLIC_NEAR_CONTRACT_ID` and `NEAR_CONTRACT_KEY_FILE` together. Keep the old account/keys/history intact. Confirm oracle, exchange and token roles remain distinct.
4. To reuse a verified, initialized six-decimal test token, retain its ID but **unset `NEAR_TEST_TOKEN_KEY_FILE`**. If token deployment itself failed, inspect that account separately; choose a fresh token account/key or an independently verified existing token. Never overwrite it as an implicit retry.
5. After approval, rebuild artifacts and invoke `npm run deploy:testnet` with those explicit replacement IDs/keys. The empty-account preflight and receipt-finality checks still apply. Never copy the old custody ledger or assert balances moved without explicit token transfers.
6. Start authorized publisher/keeper processes with the replacement configuration; check `/api/ready`, finalized `status`, token balances and `audit`. Redirect the client only after configuration verification. Old funded custody remains with the old contract until actual withdrawals/redeposits occur.

The local CLI test proves funded token/exchange storage is unchanged after a rejected rerun and after replacement deployment, and that code-only interrupted accounts reject. It does not prove a public migration, automatically recover every interruption, or override separate release review and operator approval.

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
