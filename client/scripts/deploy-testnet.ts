import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Account } from "near-api-js";
import { ACTIVE_MARKETS } from "../config";
import { signer, read, send, exchangeId } from "./near-runtime";
import { assertDeploymentRoles, assertFreshDeployment } from "./deployment-preflight";

// SDK writes resolve optimistically; dependent finalized reads must wait for receipts.
async function finalized(account: Account, transaction: ReturnType<Account["functionCall"]>) {
  const outcome = await transaction;
  const result = await account.connection.provider.txStatusReceipts(outcome.transaction.hash, account.accountId, "FINAL");
  if (typeof result.status === "object" && "Failure" in result.status || result.receipts_outcome.some(r => typeof r.outcome.status === "object" && "Failure" in r.outcome.status)) throw new Error("Deployment receipt failed; inspect the account before recovery");
  return result;
}

async function main() {
  const owner = await signer("NEAR_CONTRACT_KEY_FILE"), oracle = await signer("NEAR_ORACLE_KEY_FILE");
  if (owner.accountId !== exchangeId || !exchangeId.endsWith(".testnet")) throw new Error("Contract signer must match the configured .testnet deployment account");
  const tokenId = process.env.NEXT_PUBLIC_NEAR_USDC_ID;
  if (!tokenId) throw new Error("Configure NEXT_PUBLIC_NEAR_USDC_ID with a six-decimal test token");
  assertDeploymentRoles(exchangeId, oracle.accountId, tokenId);
  await assertFreshDeployment(exchangeId, request => owner.connection.provider.query(request));
  if (process.env.NEAR_TEST_TOKEN_KEY_FILE) {
    const token = await signer("NEAR_TEST_TOKEN_KEY_FILE");
    if (token.accountId !== tokenId || !tokenId.endsWith(".testnet")) throw new Error("Test token signer mismatch");
    await assertFreshDeployment(tokenId, request => token.connection.provider.query(request));
    await finalized(token, token.deployContract(await readFile(resolve("../contracts/artifacts/nearflow_test_token.wasm"))));
    await finalized(token, token.functionCall({ contractId: tokenId, methodName: "new", args: {}, gas: 50_000_000_000_000n }));
  }
  const metadata = await read<{ decimals: number; symbol: string }>(owner, "ft_metadata", {}, tokenId);
  if (metadata.decimals !== 6) throw new Error("NEARFlow requires six-decimal collateral");
  await finalized(owner, owner.deployContract(await readFile(resolve("../contracts/artifacts/nearflow_perps.wasm"))));
  await finalized(owner, owner.functionCall({ contractId: exchangeId, methodName: "new", gas: 80_000_000_000_000n,
    args: { token_id: tokenId, oracle_id: oracle.accountId, deposit_cap: "10000000000" } }));
  for (const m of Object.values(ACTIVE_MARKETS)) {
    await finalized(owner, send(owner, "add_market", { market_id: m.marketId, symbol: m.baseAsset,
      initial_margin_bps: m.initialMarginBps, maintenance_margin_bps: m.maintenanceMarginBps,
      max_open_interest: String(m.maxOpenInterestBase * 1e6) }));
  }
  const tokenBounds = await read<{ min: string }>(owner, "storage_balance_bounds", {}, tokenId);
  await finalized(owner, owner.functionCall({ contractId: tokenId, methodName: "storage_deposit", args: { account_id: exchangeId, registration_only: true }, attachedDeposit: BigInt(tokenBounds.min) }));
  const bounds = await read<{ min: string }>(owner, "storage_balance_bounds");
  await finalized(owner, owner.functionCall({ contractId: exchangeId, methodName: "storage_deposit", args: { account_id: oracle.accountId, registration_only: true }, attachedDeposit: BigInt(bounds.min) }));
  console.log(`Deployed NEARFlow to ${exchangeId}; collateral: ${metadata.symbol} (${tokenId}).`);
  console.log("Start the oracle and keeper, then check /api/ready before submitting test orders.");
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
