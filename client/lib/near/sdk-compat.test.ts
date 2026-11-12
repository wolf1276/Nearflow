import test from "node:test";
import assert from "node:assert/strict";
import { KeyPair, providers, transactions } from "near-api-js";
import { actionCreators, najActionToInternal } from "@near-wallet-selector/core";

test("wallet actions use the selector's own native NEAR transaction classes", () => {
  const args = new TextEncoder().encode(JSON.stringify({ amount: "1000000" }));
  const action = actionCreators.functionCall("withdraw", args, 100000000000000n, 1n);
  const internal = najActionToInternal(action);
  assert.equal(internal.type, "FunctionCall");
  if (internal.type === "FunctionCall") {
    assert.equal(internal.params.methodName, "withdraw");
    assert.equal(internal.params.deposit, "1");
  }
});

test("deployment/Sandbox SDK serializes a signed transaction without class-version conflicts", async () => {
  const key = KeyPair.fromRandom("ed25519");
  const transaction = transactions.createTransaction("alice.testnet", key.getPublicKey(), "desk.testnet", 1,
    [transactions.functionCall("cancel_all", {}, 100000000000000n, 1n)], new Uint8Array(32));
  const signed = new transactions.SignedTransaction({ transaction,
    signature: new transactions.Signature({ keyType: 0, data: new Uint8Array(64) }) });
  const provider = new providers.JsonRpcProvider({ url: "http://127.0.0.1:1" });
  let called = false;
  provider.sendJsonRpc = async <T>(method: string, params: object): Promise<T> => {
    assert.equal(method, "send_tx");
    const encoded = (params as { signed_tx_base64?: string }).signed_tx_base64;
    assert.ok(typeof encoded === "string" && encoded.length > 10);
    called = true;
    return { status: { SuccessValue: "" }, receipts_outcome: [] } as T;
  };
  await provider.sendTransaction(signed);
  assert.equal(called, true);
});
