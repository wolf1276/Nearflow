# V8 — genuine execution feasibility and approval decision

## Disposition

V8 is **not complete or activated**. The instruction to work on V8 authorizes this investigation, not a guessed venue/collateral choice, public spending budget, or bypass of S1–S3/D1. No credentials were loaded, transactions signed, contracts deployed, pools created or tokens moved.

Unlike PAPER execution, genuine spot requires deciding where the strategy's actual collateral and acquired base token reside. Implementing a generic swap signer before that decision would bypass the existing custody constraints.

## Candidate investigated: Rhea / Ref V1 on NEAR testnet

This is engineering investigation of primary SDK source and public finalized RPC, **not** a sponsor recommendation or an audit. The fetched Colosseum resource index has no NEAR track; its other ecosystems were not used as NEAR recommendations.

Primary source inspected: `ref-finance/ref-sdk`, commit `8dcb4fb47d3bf5212bdbd94a96c5afa8c7365a7d`:

- [README / testnet configuration](https://github.com/ref-finance/ref-sdk/blob/8dcb4fb47d3bf5212bdbd94a96c5afa8c7365a7d/README.md)
- [V1 instant-swap transaction construction](https://github.com/ref-finance/ref-sdk/blob/8dcb4fb47d3bf5212bdbd94a96c5afa8c7365a7d/src/v1-swap/instantSwap.ts)
- [Swap estimation](https://github.com/ref-finance/ref-sdk/blob/8dcb4fb47d3bf5212bdbd94a96c5afa8c7365a7d/src/v1-swap/swap.ts)

The SDK documents testnet contracts `ref-finance-101.testnet` and `wrap.testnet`. These are **external candidate venue/token accounts**, not deployed Reflex exchange accounts or app configuration.

Read-only RPC observations from this investigation:

| Finalized query | Observed result |
|---|---|
| `ref-finance-101.testnet.get_number_of_pools({})` | `2952`, block `277324776`, hash `4onMHeFFSsrg8YmT77K4Czcz1pU1mvgB6Jzb2DNZo1wv` |
| `wrap.testnet.ft_metadata({})` | NEP-141 wNEAR, **24 decimals**, block `277324781`, hash `71U1yweoNwgUcmx1f2HYq2VEyg4hRmqxFU8R6jpnEZEZ` |

These are historical liveness/metadata observations. They do **not** establish a suitable collateral pool, available depth, executable price, verified venue code, strategy custody permissions or current liquidity. The SDK itself disclaims losses; its float-based quote helper is not appropriate as our authoritative integer-money/risk calculation. No SDK dependency was installed.

The inspected V1 swap builder registers the output-token recipient, then calls the input token's `ft_transfer_call` with the venue receiver, bounded input amount and swap actions including `pool_id`, token IDs and `min_amount_out`. Its normal path requires 1 yoctoNEAR and a large gas budget. A generic signed wallet swap would spend the wallet's token balance, **not** an isolated exchange strategy allocation. We must not label it a strategy executor.

## Blocking custody / asset decision

The exchange presently supports one immutable **six-decimal custom test collateral token**. Its example environment contains no public exchange/token deployment IDs. No matching public collateral/wNEAR pool has been established by the existing work. wNEAR's 24 decimals cannot be silently treated as the PAPER adapter's six-decimal base units.

Two materially different paths require owner approval:

1. **Preserve custom collateral; create and fund a dedicated testnet pool on the candidate venue.** Keeps the existing collateral product design, but requires a fresh collateral/exchange deployment, an actual custom-token/wNEAR pool, funded token storage and an explicitly approved NEAR/liquidity budget. The custom token remains a faucet test token, not valuable/pegged USDC. Thin owner-seeded test liquidity must be disclosed.
2. **Use an existing venue pool and its six-decimal collateral token.** First verify the exact token metadata, pool ID, reserves, fees, contract semantics and executable depth. This changes the exchange's selected collateral and requires explicit approval of that token's trust/faucet/admin model plus a fresh exchange deployment. No existing token/pool has been chosen or approved here.

Do not swap using manual owner balances as a substitute for strategy custody. Do not create a mock venue and claim genuine integration. No bridge/Intents dependency is needed merely for branding.

## Required authority design after that decision

Before implementing/activating real spending, review the concrete ABI and tests for:

- Immutable owner, payout, collateral/base token identities, venue and single approved pool; deny arbitrary receivers, contracts, token IDs, routes and generic calls.
- Owner-confirmed on-chain policy revision/hash; per-action and aggregate notional/turnover/cost, reserve/margin, delta/time, quote/oracle expiry, slippage/min-output, epoch/nonce, cooldown and retry limits on the authoritative contract path.
- Explicit strategy collateral reservation before any asynchronous cross-contract transfer; spot inventory and in-flight liabilities recorded once, with exact **6 ↔ 24 decimal** conversion and dust rules. No second spendable collateral ledger or pooled shares.
- Actual token-output ownership and same-strategy callback/refund recovery; duplicate/out-of-order receipts, failed output transfer and venue-retained balances must reconcile before retries or settled withdrawal.
- Permissionless counterparty close/liquidation and capped short gains can leave residual real wNEAR. Both exposures and pending receipts must be independently reconciled; owner pause cannot pretend an in-flight swap disappeared.
- Executor cannot withdraw, change owner/payout/policy or spend another allocation. Existing owner-only methods cannot simply be handed to a full-access bot key and called restricted delegation. Exact NEAR access-key/deposit constraints must be tested against the actual restricted entrypoints.
- Unwind/settled asset exits must obey the approved venue/oracle constraints and pay only the immutable owner. The old collateral-only empty-close rule cannot silently discard acquired base tokens.

## Evidence still required

Local contract/adversarial tests and actual-Wasm signed Sandbox receipt chains must cover the reviewed authority and accounting first. Genuine venue integration then needs separately approved dedicated public roles/funding and recorded signed two-leg receipts, actual balances, failures/partials and restart evidence. S1–S3/D1 are not closed by this candidate review.

**Decision requested:** approve the candidate venue and choose custom-token/new-pool versus existing-pool collateral. Public account IDs, funding/NEAR/liquidity limits and activation approval remain separate inputs. Until then, `execution-gate.ts` and Guardian's genuine/mixed-mode refusal remain unchanged.
