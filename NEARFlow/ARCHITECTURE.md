# NEARFlow architecture

## Atomic settlement

`contracts/exchange/` combines custody and execution in one NEAR state machine. This deliberately avoids assuming that NEAR cross-contract calls are synchronous. The only asynchronous asset movement is the NEP-141 boundary: transfer-call deposits and token withdrawals. Margin never moves between contracts during a fill.

Users authorize mutations with wallet transactions and exactly one yoctoNEAR for order entry, cancellation, closing and withdrawal. Owners are derived from `predecessor_account_id`, never a claimed public key/address or an off-chain signature. A monotonically increasing per-account nonce survives cancellation and history pruning.

## Custody invariant

```text
token custody = available collateral + order escrow + pair margin
              + insurance + pending withdrawals
```

`audit()` computes this invariant. `ft_on_transfer` accepts only the immutable configured token. Unregistered senders, invalid messages and over-cap deposits return the full unused amount to the standard token resolver. `msg="insurance"` is an explicit irrevocable donation, not a user deposit.

Withdrawal debits available collateral before making a token transfer and reserves a funded callback. Success reduces custody/pending liabilities; failure restores the user's balance. Locked order/position margin cannot be withdrawn. Pausing or stale oracle data does not block available-balance withdrawal or order cancellation.

Registration prepays 32,768 bytes per account for bounded account/order/position/history state. There is no account unregistration or registration refund path. Global bounded history storage and runtime balance require deployment-account NEAR funding. The exchange itself must register on the token. The deployment script verifies six token decimals; this implementation treats settlement tokens as one test USD, not an oracle-priced collateral basket.

## Order book and risk

Orders lock an estimated initial margin plus fees before entering a bounded on-chain book. Execution is price-time prioritized among funded orders, skips self-trades, respects limit/expiry constraints and stays within 5% of the current oracle. New orders auto-match up to eight fills; permissionless `match_orders` and `match_candidate` continue work. IOC orders cancel/unlock any remainder. Post-only rejects immediately executable orders. Insufficiently funded orders cannot execute if the market has moved since reservation; they remain cancellable and expire normally.

Initial margin is at least 10% on testnet; maintenance is separately configured below initial margin. Each fill locks two isolated margins in one paired lot. Both sides' size contributes equally to open interest. Either owner may close all or part of a pair at the oracle, affecting both traders. Reduce-only orders directly close owned opposing lots without opening exposure; unfilled reductions do not rest in the book.

PnL is the signed size/price difference capped between the two collateral margins. There is no unsecured bad debt or synthetic claim against unrelated users. This capped bilateral model is intentionally different from a conventional uncapped cross-margin perp venue. The client banner documents the distinction.

## Oracle, funding and liquidation

A separate authorized oracle account publishes monotonically timestamped positive prices with at most 10 seconds ingress delay and no future timestamps. Execution requires a price at most 60 seconds old. `scripts/oracle.ts` computes the median of at least two feeds, rejecting >3% divergence. The publisher is trusted, can influence settlement and must be operationally secured; this is not a trustless oracle.

A cumulative funding index derives from recent execution premium over the oracle, capped at +/-10 bps per hour. Index accrual stops after oracle expiry. Pairs snapshot the index on opening; settlement transfers funding only between their margins. Applying it twice at the same index has no effect. Views estimate unsettled funding; keepers or closes persist payments and history.

Anyone with registered storage may liquidate a pair when either side's equity reaches maintenance margin. The affected pair closes atomically. Up to 50 bps of notional, bounded by remaining loser equity, is charged as a liquidation fee; half is a liquidator reward, the remainder insurance. Insurance also holds opening fees; there is no admin extraction function.

## Application and operations

- `client/lib/near/`: exact amount parsing, RPC, native wallet actions, receipt validation and read models.
- `client/app/api/[...path]/route.ts`: read-only finalized chain projections. Mutation requests return 405; there is no fee-payer or secondary settlement-auth service.
- Wallet redirects are correlated to the expected signer/receiver and checked for receipt failures, refunds and unsuccessful withdrawal callbacks. The interface never treats a web-wallet redirect as a successful fill.
- The order list reconciles against on-chain state rather than relying on persisted pending intents.
- Charts/ticker statistics may use external spot data for reference. Only a fresh contract oracle price can drive order submission/closing. Readiness also verifies the configured token against contract state.
- The keeper expires orders, obtains funded match candidates, liquidates unhealthy pairs, settles funding and checks custody accounting.
- The latest 512 global events and latest 32 account orders are retained. Full archival analytics would require an external event indexer; current APIs label bounded history and never invent an archive.

## Trust and verification

The contract is testnet-only and not audited. Full-access custody-account keys can replace deployed code; owner controls pauses and publisher rotation. Separate oracle credentials have no direct ability to withdraw other accounts' funds. The test token is unrestricted faucet money, not real USDC.

Unit tests exercise authorization, margin locks, replay protection, partial execution, oracle freshness, funding, liquidation, price gaps and custody invariants. A pinned Sandbox integration test runs actual token/engine Wasm and asynchronous receipt chains. Browser-wallet signing and a public deployment remain operator verification steps, not claims of completed live deployment.
