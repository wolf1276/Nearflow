import test from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { Worker, type NearAccount, parseNEAR } from "near-workspaces";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { KeyPair, keyStores } from "near-api-js";
import { assertFreshDeployment } from "./deployment-preflight";
import { finalizedSource, signalFrom } from "../../services/guardian/funding-source";
import { FundingLoop } from "../../services/guardian/funding-loop";
import { Guardian, type Journal } from "../../services/guardian/guardian";
import { PaperAdapter } from "../../packages/adapters/paper";
import { Store } from "../../packages/vault/store";
import type { Quote } from "../../packages/adapters/types";

const gas = 250000000000000n;
test("real NEAR receipts: custody, match, close, refund, liquidation and withdrawal recovery", { timeout: 300000 }, async t => {
  const sandbox = await Sandbox.start({ version: "2.14.0" });
  // near-sandbox 0.3.5 leaves stderr unread; long fast-forwards fill its socket
  // and block tracing shutdown. Drain node diagnostics (contract logs still assert below).
  (sandbox as unknown as { childProcess: ChildProcess }).childProcess.stderr?.resume();
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
      await worker.provider.fastForward(3);
      await assertFreshDeployment(a.accountId, request => worker.provider.query(request));
      await a.deploy(resolve("../contracts/artifacts", wasm));
      await worker.provider.fastForward(3);
      // Even uninitialized code must not be mistaken for a fresh account.
      await assert.rejects(assertFreshDeployment(a.accountId, request => worker.provider.query(request)), /has code/);
      return a;
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
      // Test oracle ingress needs current chain time after large fast-forwards;
      // finalized headers may lag >10s. Funding reads below remain finalized.
      let block = await worker.provider.block({ finality: "optimistic" });
      let timestamp = Math.floor(Number(block.header.timestamp_nanosec) / 1e9);
      if (timestamp <= lastTimestamp) { await worker.provider.fastForward(2); block = await worker.provider.block({ finality: "optimistic" }); timestamp = Math.floor(Number(block.header.timestamp_nanosec) / 1e9); }
      await root.call(exchange, "publish_price", { market_id: 1, price: value, timestamp }, { attachedDeposit: 1n }); lastTimestamp = timestamp;
    }
    let nonce = 0;
    async function order(a: NearAccount, long: boolean) {
      return a.call(exchange, "place_order", { market_id: 1, is_long: long, size: "1000000", limit_price: "100000000000000000000",
        nonce: String(++nonce), expiry_ts: String(lastTimestamp + 3600), leverage: 10, reduce_only: false, post_only: false, immediate_or_cancel: false }, { gas, attachedDeposit: 1n });
    }
    // Leave enough room in the hour for the bounded restart/outage scenario.
    let clock = await exchange.view<{ timestamp: number }>("funding_snapshot", {});
    for (let n = 0; n < 12 && clock.timestamp % 3600 > 3300; n++) {
      await worker.provider.fastForward(100);
      clock = await exchange.view<{ timestamp: number }>("funding_snapshot", {});
    }
    assert(clock.timestamp % 3600 <= 3300);
    await price("100000000000000000000"); await order(alice, true); await order(bob, false);
    assert.equal((await exchange.view<unknown[]>("positions", { account_id: alice.accountId })).length, 1); await audit();
    // Exercise the actual finalized JSON-RPC API projection, not a mocked reader.
    process.env.NEXT_PUBLIC_NEAR_CONTRACT_ID = exchange.accountId;
    process.env.NEXT_PUBLIC_NEAR_USDC_ID = token.accountId;
    process.env.NEXT_PUBLIC_NEAR_RPC_URL = sandbox.rpcUrl;
    const { venueGet } = await import("../lib/near/venue-api");
    const api = async (path: string) => {
      // Sandbox fast-forward advances chain time, not this process's wall clock.
      const block = await worker.provider.block({ finality: "final" });
      const clock = t.mock.method(Date, "now", () => Math.floor(Number(block.header.timestamp_nanosec) / 1e6));
      try { return await venueGet(new URL(`http://nearflow.local/api/${path}`)); }
      finally { clock.mock.restore(); }
    };
    const readiness = await api("ready");
    assert.equal(readiness.status, 200);
    assert(Number.isSafeInteger((readiness.body as { asOf: number }).asOf));
    const snapshot = await exchange.view<{ timestamp: number; status: { token_id: string }; markets: Array<{ market_id: number }> }>("funding_snapshot", {});
    assert(snapshot.timestamp >= lastTimestamp);
    assert.equal(snapshot.status.token_id, token.accountId);
    assert.equal(snapshot.markets[0].market_id, 1);
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
    // Apply the authoritative controller using a real mark/index premium.
    await price("99000000000000000000");
    const fundingBlock = await worker.provider.block({ finality: "final" });
    const epoch = String(Math.floor(Number(fundingBlock.header.timestamp_nanosec) / 1e9 / 3600));
    await keeper.call(exchange, "update_funding", { market_id: 1, epoch }, { gas, attachedDeposit: 1n });
    const applied = await exchange.view<{ funding_rate_ppm: number; controller: { mode: string } }>("get_market", { market_id: 1 });
    assert.equal(applied.funding_rate_ppm, 2000);
    assert.equal(applied.controller.mode, "BASELINE");
    // Exercise the production read-only loop transport against actual finalized Wasm state.
    const fundingSource = finalizedSource(sandbox.rpcUrl, exchange.accountId, "LOCAL_SANDBOX");
    let finalized = await fundingSource.read();
    for (let n = 0; n < 20 && finalized.snapshot.markets[0].funding_rate_ppm !== 2000; n++) {
      await new Promise(resolve => setTimeout(resolve, 100)); finalized = await fundingSource.read();
    }
    const loopSignal = signalFrom(finalized, exchange.accountId, 1, finalized.snapshot.timestamp); // Sandbox chain clock only; production uses wall clock.
    assert.equal(loopSignal.scope, "LOCAL_SANDBOX"); assert.equal(loopSignal.ppm, 2000n); assert.equal(loopSignal.usable, true);
    assert.equal(loopSignal.matchedOpenInterest, 1_000_000n); assert(finalized.blockHeight > 0);
    await assert.rejects(keeper.call(exchange, "update_funding", { market_id: 1, epoch }, { gas, attachedDeposit: 1n }), /ExecutionError/);
    assert.equal((await exchange.view<{ funding_rate_ppm: number }>("get_market", { market_id: 1 })).funding_rate_ppm, applied.funding_rate_ppm);
    await worker.provider.fastForward(10);
    await keeper.call(exchange, "settle_funding", { position_id: "0" }, { gas, attachedDeposit: 1n });
    await audit();
    // Run the actual CLI in independent processes: no in-memory epoch state survives.
    const credentialDir = await mkdtemp(join(tmpdir(), "reflex-keeper-"));
    try {
      const key = await keeper.getKey();
      assert(key);
      const credentialFile = join(credentialDir, "keeper.json");
      await writeFile(credentialFile, JSON.stringify({ account_id: keeper.accountId, private_key: key.toString() }), { mode: 0o600 });
      async function runKeeper() {
        const { stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", resolve("scripts/keeper.ts"), "--once"], {
          timeout: 30_000,
          env: { ...process.env, NEAR_KEEPER_KEY_FILE: credentialFile, NEXT_PUBLIC_NEAR_NETWORK: "testnet",
            NEXT_PUBLIC_NEAR_RPC_URL: sandbox.rpcUrl, NEXT_PUBLIC_NEAR_CONTRACT_ID: exchange.accountId },
        });
        assert.doesNotMatch(stderr, /(update_funding|match_orders|settle_funding|liquidate):/);
      }
      type FundingState = { timestamp: number; funding_index: string; funding_rate_ppm: number; controller: { last_epoch: number; fallback: boolean } };
      await runKeeper(); // same epoch: must not submit a replay
      assert.equal((await exchange.view<FundingState>("get_market", { market_id: 1 })).controller.last_epoch, Number(epoch));
      await worker.provider.fastForward(300);
      const expired = await exchange.view<FundingState>("get_market", { market_id: 1 });
      const outageClock = await exchange.view<{ timestamp: number }>("funding_snapshot", {});
      assert(outageClock.timestamp - expired.timestamp > 60);
      await runKeeper(); // stale oracle: neither apply funding nor settle using stale input
      const stale = await exchange.view<FundingState>("get_market", { market_id: 1 });
      assert.equal(stale.controller.last_epoch, Number(epoch));
      assert.equal(stale.funding_index, expired.funding_index);
      await price("99000000000000000000");
      await runKeeper(); // fresh index in the same hour: don't reapply the quote
      const resumed = await exchange.view<FundingState>("get_market", { market_id: 1 });
      assert.equal(resumed.controller.last_epoch, Number(epoch));
      assert.equal(resumed.funding_rate_ppm, 2000);
      const resumedSnapshot = await exchange.view<{ timestamp: number; markets: FundingState[] }>("funding_snapshot", {});
      const current = resumedSnapshot.markets[0];
      const elapsed = BigInt(resumedSnapshot.timestamp - current.timestamp);
      const maximumFreshAccrual = 99n * 10n ** 18n * 2000n * elapsed / (1_000_000n * 3600n);
      assert(BigInt(current.funding_index) >= BigInt(expired.funding_index));
      assert(BigInt(current.funding_index) - BigInt(expired.funding_index) <= maximumFreshAccrual); // stale gap is not backfilled
      await runKeeper();
      assert.equal((await exchange.view<FundingState>("get_market", { market_id: 1 })).controller.last_epoch, resumed.controller.last_epoch);
      await audit();
    } finally { await rm(credentialDir, { recursive: true, force: true }); }
    // A price gap cannot create bad debt: pair payout is capped to escrow.
    await price("104000000000000000000");
    await alice.call(exchange, "close_position", { position_id: "0" }, { gas, attachedDeposit: 1n });
    const aliceStats = (await exchange.view<{ stats: { funding: string; realized_pnl: string } }>("get_account", { account_id: alice.accountId })).stats;
    const bobStats = (await exchange.view<{ stats: { funding: string; realized_pnl: string } }>("get_account", { account_id: bob.accountId })).stats;
    assert.equal(aliceStats.realized_pnl, "4000000");
    assert.equal(bobStats.realized_pnl, "-4000000");
    assert.equal(BigInt(aliceStats.funding) + BigInt(bobStats.funding), 0n);
    assert(BigInt(aliceStats.funding) < 0n);
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
    const { defaults } = await import("../../packages/funding/preview");
    const params = Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, Number(v)]));
    await assert.rejects(alice.call(exchange, "configure_funding", { market_id: 1, mode: "ADAPTIVE", params, expected_revision: 1 }, { gas, attachedDeposit: 1n }), /ExecutionError/);
    await exchange.call(exchange, "configure_funding", { market_id: 1, mode: "ADAPTIVE", params, expected_revision: 1 }, { gas, attachedDeposit: 1n });
    const configured = await exchange.view<{ funding_rate_ppm: number; controller: { mode: string; revision: number } }>("get_market", { market_id: 1 });
    assert.equal(configured.controller.mode, "ADAPTIVE");
    assert.equal(configured.controller.revision, 2);
    assert.equal(configured.funding_rate_ppm, 0);
    await audit();
    // Actual finalized funding → durable PAPER loop, not a signed real hedge.
    const loopDir = await mkdtemp(join(tmpdir(), "reflex-loop-sandbox-"));
    try {
      async function nextFundingEpoch() {
        let time = (await exchange.view<{ timestamp: number }>("funding_snapshot", {})).timestamp;
        const target = (Math.floor(time / 3600) + 1) * 3600 + 5;
        for (let n = 0; n < 24 && time < target; n++) {
          // Sandbox blocks advance ~0.3s, not one second; keep bounded block chunks.
          await worker.provider.fastForward(1000);
          time = (await exchange.view<{ timestamp: number }>("funding_snapshot", {})).timestamp;
          console.log(`Local loop Sandbox epoch advance ${n + 1}: ${time}/${target}`);
        }
        assert(time >= target);
        await price("100000000000000000000"); await order(alice, true); await order(bob, false);
        await price("99000000000000000000");
        const now = (await exchange.view<{ timestamp: number }>("funding_snapshot", {})).timestamp;
        const nextEpoch = Math.floor(now / 3600);
        await keeper.call(exchange, "update_funding", { market_id: 1, epoch: String(nextEpoch) }, { gas, attachedDeposit: 1n });
        let read = await fundingSource.read();
        for (let n = 0; n < 30 && read.snapshot.markets[0].controller?.last_epoch !== nextEpoch; n++) {
          await new Promise(resolve => setTimeout(resolve, 100)); read = await fundingSource.read();
        }
        assert.equal(read.snapshot.markets[0].controller?.last_epoch, nextEpoch);
        assert(read.snapshot.markets[0].funding_rate_ppm! >= 100);
        return read;
      }
      let read = await nextFundingEpoch(), chainClock = read.snapshot.timestamp;
      const q = (leg: "spot" | "perp", at: number): Quote => ({ mode: "PAPER", leg, market: "NEAR/USD", id: `${leg}-${Math.floor(at / 3600)}`, at, expires: at + 600,
        price: leg === "spot" ? 99_000_000n : 100_000_000n, depth: 10_000_000n, feeBps: 1n, slippageBps: 0n, available: true });
      const spot = new PaperAdapter("spot", new Store(join(loopDir, "spot.json"))), perp = new PaperAdapter("perp", new Store(join(loopDir, "perp.json")));
      await spot.initialize("sandbox-paper", 500_000_000n, q("spot", chainClock));
      await perp.initialize("sandbox-paper", 500_000_000n, q("perp", chainClock), 100_000_000n);
      const guardian = new Guardian(new Store<Journal>(join(loopDir, "guardian.json")), spot, perp);
      await guardian.create({ version: 1, revision: 1, owner: alice.accountId, strategy: "sandbox-paper", mode: "PAPER", autoOpen: true, autoReduce: true, autoClose: true,
        maxGross: 300_000_000n, maxDelta: 1_000_000n, maxDeltaSeconds: 60, minReserve: 1_000_000n, minMarginBps: 1000n, maxSlippageBps: 20n,
        maxDailyTurnover: 1_000_000_000n, minNetCarry: 1n, maxActionCost: 1_000_000n, maxTotalCost: 10_000_000n, cooldownSeconds: 0, maxRetries: 3, maxParticipationBps: 5000n }, alice.accountId);
      const source = { async read() { const r = await fundingSource.read(); chainClock = r.snapshot.timestamp; return r; } };
      const loop = new FundingLoop(new Store(join(loopDir, "loop.json")), source, [guardian], () => chainClock);
      await loop.initialize({ version: 1, contract: exchange.accountId, scope: "LOCAL_SANDBOX", marketId: 1, entryPpm: 100n, exitPpm: 0n,
        persistenceEpochs: 2, cooldownSeconds: 60, maxEpochGross: 1_000_000_000n, maxDailyGross: 3_000_000_000n, maxEpochCosts: 1_000_000n,
        maxParticipationBps: 5000n, horizonSeconds: 3600, repairCost: 0n, reserveCost: 0n }, { "sandbox-paper": 1_000_000n });
      // Sandbox-only clock injection avoids altering HTTP client's global timers.
      // NEAR_TESTNET always checks wall time and ignores this optional clock.
      const tick = () => loop.tick(chainClock);
      console.log("Local loop Sandbox: first finalized observation");
      await tick(); assert.equal((await guardian.snapshot()).intents.length, 0);
      console.log("Local loop Sandbox: first observation recorded; advancing second epoch");
      read = await nextFundingEpoch(); chainClock = read.snapshot.timestamp;
      await spot.market(q("spot", chainClock)); await perp.market(q("perp", chainClock));
      const realBefore = await balance(alice), realOi = read.snapshot.markets[0].open_interest;
      console.log("Local loop Sandbox: second finalized observation and entry");
      await tick();
      console.log("Local loop Sandbox: second observation processed");
      const opening = await guardian.snapshot(); assert.equal(opening.state, "opening"); assert.equal(opening.intents.length, 2);
      for (const i of opening.intents) await (i.request.leg === "spot" ? spot : perp).fill(i.request.id, i.request.size, chainClock);
      await tick();
      assert.equal((await guardian.snapshot()).state, "hedged");
      assert.equal((await spot.quote(chainClock)).depth, 9_000_000n);
      assert.equal(await balance(alice), realBefore);
      assert.equal((await fundingSource.read()).snapshot.markets[0].open_interest, realOi);
      assert.equal((await loop.snapshot()).feedback.entries, 1); await audit();
      console.log("Sandbox finalized funding epochs drove an allowed independent PAPER hedge; only PAPER depth changed, chain balances and matched OI did not");
    } finally { await rm(loopDir, { recursive: true, force: true }); }
    console.log("Sandbox verified: custody, refunds, fills, capped PnL, liquidation, withdrawals, funding application/replay/settlement, owner-only mode changes and finalized-read PAPER loop");
  } finally { await worker.tearDown(); await sandbox.tearDown(); }
});
