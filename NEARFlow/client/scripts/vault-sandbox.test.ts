import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Worker, type NearAccount, parseNEAR } from "near-workspaces";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { KeyPair, keyStores } from "near-api-js";

const gas = 250000000000000n;
const tx = { gas, attachedDeposit: 1n };
interface Strategy { strategy_id: string; owner_id: string; available: string; pending_withdrawals: string; pending_count: number; closed: boolean }

test("real vault receipts: isolated allocations, token refunds, fixed-owner withdrawals and callback recovery", { timeout: 180000 }, async () => {
  const sandbox = await Sandbox.start({ version: "2.14.0" });
  const worker = await Worker.init({ network: "custom", rpcAddr: sandbox.rpcUrl, rootAccountId: DEFAULT_ACCOUNT_ID, keyStore: new keyStores.InMemoryKeyStore() });
  try {
    const root = worker.rootAccount;
    await root.setKey(KeyPair.fromString(DEFAULT_PRIVATE_KEY));
    async function deploy(name: string, wasm: string): Promise<NearAccount> {
      const a = root.getAccount(`${name}.testnet`);
      await a.updateAccount({ amount: parseNEAR("30").toString() });
      const key = await a.setKey(); await a.updateAccessKey(key);
      await a.deploy(resolve("../contracts/artifacts", wasm)); return a;
    }
    const exchange = await deploy("reflex-vault", "nearflow_perps.wasm");
    const token = await deploy("reflex-collateral", "nearflow_test_token.wasm");
    const alice = await root.createSubAccount("alice"), bob = await root.createSubAccount("bob");
    await token.call(token, "new", {});
    await exchange.call(exchange, "new", { token_id: token.accountId, oracle_id: root.accountId, deposit_cap: "1000000000" });
    await exchange.call(exchange, "add_market", { market_id: 1, symbol: "NEAR", initial_margin_bps: 1000, maintenance_margin_bps: 500, max_open_interest: "1000000000" }, tx);
    const storage = await exchange.view<{ min: string }>("storage_balance_bounds", {});
    const tokenStorage = await token.view<{ min: string }>("storage_balance_bounds", {});
    const strategyStorage = await exchange.view<string>("strategy_storage_cost", {});
    await root.call(token, "storage_deposit", { account_id: exchange.accountId }, { attachedDeposit: BigInt(tokenStorage.min) });
    for (const a of [alice, bob]) {
      await a.call(exchange, "storage_deposit", {}, { attachedDeposit: BigInt(storage.min) });
      await a.call(token, "faucet", {});
    }
    const create = (a: NearAccount, cap: string) => a.call<Strategy>(exchange, "create_strategy", { market_id: 1, collateral_cap: cap }, { gas, attachedDeposit: BigInt(strategyStorage) });
    const s = await create(alice, "20000000"), other = await create(bob, "10000000");
    const get = (id = s.strategy_id) => exchange.view<Strategy>("get_strategy", { strategy_id: id });
    const balance = (a: NearAccount) => token.view<string>("ft_balance_of", { account_id: a.accountId });
    const transfer = (a: NearAccount, amount: string, msg: string) => a.call(token, "ft_transfer_call", { receiver_id: exchange.accountId, amount, msg }, tx);
    async function audit() {
      const state = await exchange.view<{ balanced: boolean; custody: string; strategy_pending_balanced: boolean }>("audit", {});
      assert.equal(state.balanced, true); assert.equal(state.strategy_pending_balanced, true);
      assert.equal(await balance(exchange), state.custody); // actual token custody, not just internal ledger
    }
    assert.equal(await transfer(alice, "10000000", `strategy:${s.strategy_id}`), "10000000");
    assert.equal((await get()).available, "10000000"); await audit();
    // The same collateral cannot remain available in the manual account.
    assert.equal(await exchange.view("balance_of", { account_id: alice.accountId, token_id: token.accountId }), "0");
    assert.equal(await transfer(alice, "20000000", ""), "20000000");
    await alice.call(exchange, "allocate_strategy", { strategy_id: s.strategy_id, amount: "5000000" }, tx);
    assert.equal((await get()).available, "15000000");
    assert.equal(await exchange.view("balance_of", { account_id: alice.accountId, token_id: token.accountId }), "15000000"); await audit();
    const bobBefore = await balance(bob);
    assert.equal(await transfer(bob, "1000000", `strategy:${s.strategy_id}`), "0");
    assert.equal(await balance(bob), bobBefore);
    assert.equal(await transfer(alice, "6000000", `strategy:${s.strategy_id}`), "0");
    await assert.rejects(bob.call(exchange, "withdraw_strategy", { strategy_id: s.strategy_id, amount: "1" }, tx), /ExecutionError/);
    assert.equal((await get()).available, "15000000");
    await alice.call(exchange, "set_strategy_paused", { strategy_id: s.strategy_id, paused: true }, tx);
    assert.equal(await transfer(alice, "1000000", `strategy:${s.strategy_id}`), "0");
    // Paused custody can exit without any oracle quote or guardian permission.
    const beforeSuccess = BigInt(await balance(alice));
    assert.equal(await alice.call(exchange, "withdraw_strategy", { strategy_id: s.strategy_id, amount: "2000000" }, tx), true);
    assert.equal(BigInt(await balance(alice)), beforeSuccess + 2000000n);
    assert.equal((await get()).available, "13000000"); await audit();
    // Force a real token receiver failure and ensure exact same-strategy restoration.
    await alice.call(token, "storage_unregister", { force: true }, tx);
    assert.equal(await alice.call(exchange, "withdraw_strategy", { strategy_id: s.strategy_id, amount: "6000000" }, tx), false);
    assert.equal((await get()).available, "13000000");
    assert.equal((await get()).pending_count, 0);
    assert.equal((await get()).pending_withdrawals, "0");
    assert.equal((await get(other.strategy_id)).available, "0"); await audit();
    await assert.rejects(alice.call(exchange, "resolve_strategy_withdraw", { withdrawal_id: "1" }, { gas }), /ExecutionError/);
    assert.equal((await get()).available, "13000000");
    await alice.call(token, "storage_deposit", {}, { attachedDeposit: BigInt(tokenStorage.min) });
    await alice.call(exchange, "release_strategy", { strategy_id: s.strategy_id, amount: "3000000" }, tx);
    assert.equal(await alice.call(exchange, "withdraw_strategy", { strategy_id: s.strategy_id, amount: "10000000" }, tx), true);
    assert.equal((await get()).available, "0"); await audit();
    await alice.call(exchange, "close_strategy", { strategy_id: s.strategy_id }, tx);
    assert.equal((await get()).closed, true);
    assert.equal(await transfer(alice, "1", `strategy:${s.strategy_id}`), "0");
    const list = await exchange.view<Strategy[]>("get_strategies", { owner_id: alice.accountId });
    assert.equal(list.length, 1); assert.equal(list[0].owner_id, alice.accountId);
    assert.equal(await exchange.view("get_strategy_withdrawal", { withdrawal_id: "0" }), null);
    await audit();
    // Owner-signed strategy trading shares custody, not the manual spendable book.
    const trading = await create(alice, "10000000");
    await alice.call(exchange, "allocate_strategy", { strategy_id: trading.strategy_id, amount: "10000000" }, tx);
    await transfer(bob, "10000000", "");
    const block = await worker.provider.block({ finality: "final" });
    const timestamp = Math.floor(Number(block.header.timestamp_nanosec) / 1e9);
    await root.call(exchange, "publish_price", { market_id: 1, price: "100000000000000000000", timestamp }, tx);
    const order = { is_long: true, size: "100000", limit_price: "100000000000000000000", nonce: "1", expiry_ts: String(timestamp + 800), leverage: 10, reduce_only: false, post_only: false, immediate_or_cancel: false };
    await assert.rejects(bob.call(exchange, "place_strategy_order", { strategy_id: trading.strategy_id, ...order }, tx), /ExecutionError/);
    const manualBefore = await exchange.view("balance_of", { account_id: alice.accountId, token_id: token.accountId });
    await alice.call(exchange, "place_strategy_order", { strategy_id: trading.strategy_id, ...order }, tx); await audit();
    await assert.rejects(alice.call(exchange, "withdraw_strategy", { strategy_id: trading.strategy_id, amount: "10000000" }, tx), /ExecutionError/);
    await bob.call(exchange, "place_order", { market_id: 1, ...order, is_long: false }, tx); await audit();
    const positions = await exchange.view<{ position_id: string; strategy_id: string }[]>("strategy_positions", { strategy_id: trading.strategy_id });
    assert.equal(positions.length, 1); assert.equal(positions[0].strategy_id, trading.strategy_id);
    assert.deepEqual(await exchange.view("positions", { account_id: alice.accountId }), []);
    await assert.rejects(alice.call(exchange, "close_position", { position_id: positions[0].position_id }, tx), /ExecutionError/);
    await alice.call(exchange, "set_strategy_paused", { strategy_id: trading.strategy_id, paused: true }, tx);
    await bob.call(exchange, "close_position", { position_id: positions[0].position_id }, tx); await audit();
    assert.equal(await exchange.view("balance_of", { account_id: alice.accountId, token_id: token.accountId }), manualBefore);
    const settled = await get(trading.strategy_id); assert.equal(settled.available, "9997000");
    assert.equal(await alice.call(exchange, "withdraw_strategy", { strategy_id: trading.strategy_id, amount: settled.available }, tx), true);
    await alice.call(exchange, "close_strategy", { strategy_id: trading.strategy_id }, tx); await audit();
    console.log("Local Sandbox vault verified: real custody/refunds, owner-only strategy escrow, matching, counterparty close, isolated payout and settled withdrawal; no autonomous real hedge claimed");
  } finally { await worker.tearDown(); await sandbox.tearDown(); }
});
