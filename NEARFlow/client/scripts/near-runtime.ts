import { readFile } from "node:fs/promises";
import { connect, keyStores, KeyPair, type Account } from "near-api-js";
import { requireAccountId } from "../lib/near/account";
export const rpcUrl = process.env.NEXT_PUBLIC_NEAR_RPC_URL || "https://rpc.testnet.near.org";
export const exchangeId = process.env.NEXT_PUBLIC_NEAR_CONTRACT_ID || "";
export async function signer(fileEnv: string): Promise<Account> {
  if (process.env.NEXT_PUBLIC_NEAR_NETWORK && process.env.NEXT_PUBLIC_NEAR_NETWORK !== "testnet") throw new Error("Testnet only");
  const path = process.env[fileEnv]; if (!path) throw new Error(`Set ${fileEnv} to a local NEAR credential JSON path`);
  const credential = JSON.parse(await readFile(path, "utf8"));
  requireAccountId(credential.account_id);
  const store = new keyStores.InMemoryKeyStore();
  await store.setKey("testnet", credential.account_id, KeyPair.fromString(credential.private_key));
  const near = await connect({ networkId: "testnet", nodeUrl: rpcUrl, keyStore: store });
  return near.account(credential.account_id);
}
export async function chainTime(account: Account): Promise<number> {
  const block = await account.connection.provider.block({ finality: "final" });
  return Math.floor(Number(block.header.timestamp_nanosec) / 1e9);
}
export async function send(account: Account, methodName: string, args: object, contractId = exchangeId) {
  requireAccountId(contractId);
  const outcome = await account.functionCall({ contractId, methodName, args, attachedDeposit: 1n, gas: 250_000_000_000_000n });
  if (typeof outcome.status === "object" && "Failure" in outcome.status || outcome.receipts_outcome.some(r => typeof r.outcome.status === "object" && "Failure" in r.outcome.status)) throw new Error(`${methodName} failed on NEAR`);
  return outcome;
}
export async function read<T>(account: Account, methodName: string, args: object = {}, contractId = exchangeId): Promise<T> {
  requireAccountId(contractId);
  return account.viewFunction({ contractId, methodName, args });
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
