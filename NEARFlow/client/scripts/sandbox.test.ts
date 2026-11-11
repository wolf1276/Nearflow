import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Worker, type NearAccount, parseNEAR } from "near-workspaces";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { KeyPair, keyStores } from "near-api-js";

const gas = 250000000000000n;
test("real NEAR receipts: custody, match, close, refund, liquidation and withdrawal recovery", { timeout: 180000 }, async () => {
  const sandbox = await Sandbox.start({ version: "2.14.0" });
  const worker = await Worker.init({ network: "custom", rpcAddr: sandbox.rpcUrl, rootAccountId: DEFAULT_ACCOUNT_ID, keyStore: new keyStores.InMemoryKeyStore() });
  try {
    const root = worker.rootAccount;
    await root.setKey(KeyPair.fromString(DEFAULT_PRIVATE_KEY));
    async function contract(name: string, wasm: string): Promise<NearAccount> {
      // Patch testnet-suffixed accounts only in local sandbox. Production contracts
      // deliberately reject initialization under non-testnet account names.
      const a = root.getAccount(`${name}.testnet`);
      await a.updateAccount({ amount: parseNEAR("30").toString() });
      const key = await a.setKey(); await a.updateAccessKey(key);
      await a.deploy(resolve("../contracts/artifacts", wasm)); return a;
    }
    const exchange = await contract("nearflow-sandbox", "nearflow_perps.wasm");
    const token = await contract("nearflow-token", "nearflow_test_token.wasm");
    const alice = await root.createSubAccount("alice"), bob = await root.createSubAccount("bob");
    const keeper = await root.createSubAccount("keeper");
    await token.call(token, "new", {});
    await exchange.call(exchange, "new", { token_id: token.accountId, oracle_id: root.accountId, deposit_cap: "1000000000" });
    await exchange.call(exchange, "add_market", { market_id: 1, symbol: "NEAR", initial_margin_bps: 1000, maintenance_margin_bps: 500, max_open_interest: "1000000000" }, { attachedDeposit: 1n });
    const storage = await exchange.view<{ min: string }>("storage_balance_bounds", {});
    const tokenStorage = await token.view<{ min: string }>("storage_balance_bounds", {});
    await root.call(token, "storage_deposit", { account_id: exchange.accountId }, { attachedDeposit: BigInt(tokenStorage.min) });
    for (const a of [alice, bob, keeper]) {
      await a.call(exchange, "storage_deposit", {}, { attachedDeposit: BigInt(storage.min) });
      await a.call(token, "faucet", {});
    }
    const transfer = (a: NearAccount, amount: string) => a.call(token, "ft_transfer_call", { receiver_id: exchange.accountId, amount, msg: "" }, { gas, attachedDeposit: 1n });
    for (const a of [alice, bob, keeper]) assert.equal(await transfer(a, "100000000"), "100000000");
    async function balance(a: NearAccount): Promise<string> { return exchange.view("balance_of", { account_id: a.accountId, token_id: token.accountId }); }
    async function audit() { const a = await exchange.view<{ balanced: boolean }>("audit", {}); assert.equal(a.balanced, true); }
    let lastTimestamp = 0;
    async function price(value: string) {
      let block = await worker.provider.block({ finality: "final" });
      let timestamp = Math.floor(Number(block.header.timestamp_nanosec) / 1e9);
      if (timestamp <= lastTimestamp) { await worker.provider.fastForward(2); block = await worker.provider.block({ finality: "final" }); timestamp = Math.floor(Number(block.header.timestamp_nanosec) / 1e9); }
      await root.call(exchange, "publish_price", { market_id: 1, price: value, timestamp }, { attachedDeposit: 1n }); lastTimestamp = timestamp;
    }
    let nonce = 0;
    async function order(a: NearAccount, long: boolean) {
      return a.call(exchange, "place_order", { market_id: 1, is_long: long, size: "1000000", limit_price: "100000000000000000000",
        nonce: String(++nonce), expiry_ts: String(lastTimestamp + 3600), leverage: 10, reduce_only: false, post_only: false, immediate_or_cancel: false }, { gas, attachedDeposit: 1n });
    }
    await price("100000000000000000000"); await order(alice, true); await order(bob, false);
    assert.equal((await exchange.view<unknown[]>("positions", { account_id: alice.accountId })).length, 1); await audit();
    // Exercise the actual finalized JSON-RPC API projection, not a mocked reader.
    process.env.NEXT_PUBLIC_NEAR_CONTRACT_ID = exchange.accountId;
    process.env.NEXT_PUBLIC_NEAR_USDC_ID = token.accountId;
    process.env.NEXT_PUBLIC_NEAR_RPC_URL = sandbox.rpcUrl;
    const { venueGet } = await import("../lib/near/venue-api");
    const api = (path: string) => venueGet(new URL(`http://nearflow.local/api/${path}`));
    assert.equal((await api("ready")).status, 200);
    // Transaction submission may return EXECUTED_OPTIMISTIC. The public API
    // deliberately waits for final state, so allow the last receipt to finalize.
    let projected = await api(`positions?address=${alice.accountId}`);
    for (let n = 0; n < 20 && !(projected.body as Array<{ size: string }>)[0]; n++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      projected = await api(`positions?address=${alice.accountId}`);
    }
    assert.equal(projected.status, 200);
    assert.equal((projected.body as Array<{ size: string }>)[0]?.size, "1000000");
    const fills = await api(`fills?address=${alice.accountId}`);
    assert.equal((fills.body as Array<{ price: string }>)[0].price, "100000000000000000000");
    // A price gap cannot create bad debt: pair payout is capped to escrow.
    await price("104000000000000000000");
    await alice.call(exchange, "close_position", { position_id: "0" }, { gas, attachedDeposit: 1n });
    const aliceStats = (await exchange.view<{ stats: { funding: string; realized_pnl: string } }>("get_account", { account_id: alice.accountId })).stats;
    const bobStats = (await exchange.view<{ stats: { funding: string; realized_pnl: string } }>("get_account", { account_id: bob.accountId })).stats;
    assert.equal(aliceStats.realized_pnl, "4000000");
    assert.equal(bobStats.realized_pnl, "-4000000");
    assert.equal(BigInt(aliceStats.funding) + BigInt(bobStats.funding), 0n);
    assert.equal(BigInt(await balance(alice)), 103970000n + BigInt(aliceStats.funding));
    assert.equal(BigInt(await balance(bob)), 95970000n + BigInt(bobStats.funding)); await audit();
    // Receiver rejects cap overflow; NEP-141 resolver returns ALL tokens to sender.
    const walletBefore = await token.view<string>("ft_balance_of", { account_id: alice.accountId });
    assert.equal(await transfer(alice, "800000000"), "0");
    assert.equal(await token.view("ft_balance_of", { account_id: alice.accountId }), walletBefore); await audit();
    // Unregister token recipient: async withdraw transfer fails, callback restores ledger.
    await bob.call(token, "storage_unregister", { force: true }, { attachedDeposit: 1n });
    const before = await balance(bob);
    const recovered = await bob.call(exchange, "withdraw", { token_id: token.accountId, amount: "5000000" }, { gas, attachedDeposit: 1n });
    assert.equal(recovered, false); assert.equal(await balance(bob), before); await audit();
    await bob.call(token, "storage_deposit", {}, { attachedDeposit: BigInt(tokenStorage.min) });
    assert.equal(await bob.call(exchange, "withdraw", { token_id: token.accountId, amount: "5000000" }, { gas, attachedDeposit: 1n }), true); await audit();
    // Another pair, then a real permissionless liquidation receipt.
    await price("100000000000000000000"); await order(alice, true); await order(bob, false);
    await price("106000000000000000000");
    await keeper.call(exchange, "liquidate", { position_id: "1" }, { gas, attachedDeposit: 1n });
    assert.equal((await exchange.view<unknown[]>("get_pairs", {})).length, 0); await audit();
    console.log("Sandbox verified: NEP-141 resolver refunds, atomic fills, capped PnL, liquidation, failed + successful withdrawal receipts");
  } finally { await worker.tearDown(); await sandbox.tearDown(); }
});
