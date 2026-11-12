import test from "node:test";
import assert from "node:assert/strict";
import { createStrategyClient } from "./strategy";
import type { call } from "./wallet";
import { ASSETS, CONTRACTS } from "@/config";

function client(owner = "alice.testnet", paused = false) {
  const sent: Parameters<typeof call>[] = [];
  const c = createStrategyClient({
    read: async <T>(method: string) => {
      if (method === "strategy_storage_cost") return "40960000000000000000000" as T;
      if (method === "get_strategy") return { owner_id: owner, paused, closed: false } as T;
      throw new Error(`Unexpected read ${method}`);
    },
    send: async (...args) => { sent.push(args); return { hash: "test-hash" }; },
  });
  return { c, sent };
}
test("strategy wallet calls preserve exact amounts/IDs and owner-fixed ABI", async () => {
  const { c, sent } = client();
  const large = 9007199254740993n;
  await c.create("alice.testnet", 1, large);
  assert.deepEqual(sent[0], [CONTRACTS.engine, "create_strategy", { market_id: 1, collateral_cap: large.toString() }, "40960000000000000000000", "alice.testnet", "200000000000000"]);
  await c.allocate("alice.testnet", large, 1000000n);
  assert.deepEqual(sent[1][2], { strategy_id: large.toString(), amount: "1000000" });
  await c.withdraw("alice.testnet", large, 1000000n);
  assert.equal(sent[2][1], "withdraw_strategy");
  assert.deepEqual(sent[2][2], { strategy_id: large.toString(), amount: "1000000" });
  assert.equal(sent[2][3], "1");
  assert.equal(sent[2][4], "alice.testnet"); // never accepts arbitrary payout recipient
});
test("strategy token deposit uses canonical message and signer; rejects foreign/paused strategies", async () => {
  const { c, sent } = client();
  await c.deposit("alice.testnet", 3n, 1000000n);
  assert.deepEqual(sent[0], [ASSETS.usdc, "ft_transfer_call", {
    receiver_id: CONTRACTS.engine, amount: "1000000", msg: "strategy:3",
  }, "1", "alice.testnet", "200000000000000"]);
  const foreign = client("bob.testnet");
  await assert.rejects(foreign.c.deposit("alice.testnet", 3n, 1n), /owner mismatch/);
  assert.equal(foreign.sent.length, 0);
  const paused = client("alice.testnet", true);
  await assert.rejects(paused.c.deposit("alice.testnet", 3n, 1n), /not accepting/);
  assert.equal(paused.sent.length, 0);
});
test("strategy trading helpers use explicit owner-signed books and bounded close ABI", async () => {
  const { c, sent } = client();
  await c.placeOrder("alice.testnet", 2n, { isLong: false, size: 1_000_000n, limitPrice: 100n * 10n ** 18n, nonce: 1n, expiry: 1000n, leverage: 10, reduceOnly: false, postOnly: false, immediateOrCancel: true });
  assert.equal(sent[0][1], "place_strategy_order"); assert.equal(sent[0][2].strategy_id, "2");
  assert.equal(sent[0][4], "alice.testnet");
  await c.cancelOrder("alice.testnet", 2n, 1n); assert.equal(sent[1][1], "cancel_strategy_order");
  await c.closePosition("alice.testnet", 2n, 3n, null, 1n, 200n * 10n ** 18n);
  assert.deepEqual(sent[2][2], { strategy_id: "2", position_id: "3", amount: null, min_price: "1", max_price: "200000000000000000000" });
  assert.throws(() => c.closePosition("alice.testnet", 2n, 3n, 0n, 1n, 2n));
  assert.throws(() => c.closePosition("alice.testnet", 2n, 3n, null, 3n, 2n));
});
test("strategy helper refuses zero/negative/overflow values before requesting wallet signing", async () => {
  const { c, sent } = client();
  for (const amount of [0n, -1n, 1n << 128n]) assert.throws(() => c.withdraw("alice.testnet", 0n, amount), /Invalid unsigned/);
  for (const id of [-1n, 1n << 64n]) assert.throws(() => c.pause("alice.testnet", id, true), /Invalid unsigned/);
  await assert.rejects(c.create("alice.testnet", 0, 1n), /market ID/);
  assert.throws(() => c.close("BAD", 0n));
  assert.equal(sent.length, 0);
});
