import test from "node:test";
import assert from "node:assert/strict";
import { venueGet, normalizeOrder, type ReadContract } from "./venue-api";
import { ASSETS } from "@/config";
import type { ChainOrder } from "./types";
const url = (path: string) => new URL(`https://nearflow.example/api/${path}`);
function snapshotReader(status: unknown, markets: unknown[], timestamp = Math.floor(Date.now() / 1000)) {
  return reader({ funding_snapshot: { status, markets, timestamp } });
}
function reader(values: Record<string, unknown>): ReadContract {
  return async <T>(method: string) => { if (!(method in values)) throw new Error(`Unexpected method ${method}`); return values[method] as T; };
}
test("orders come from contract state with bigint strings intact", async () => {
  const o = { owner: "alice.testnet", id: "1", nonce: "9007199254740993", market_id: 1, is_long: true, size: "1000000", remaining: "500000", filled_size: "500000", limit_price: "100000000000000000000", margin: "5000000", expiry_ts: "9999999999", cancelled: false, created_at: 1000, reduce_only: false, leverage: 10, post_only: false } satisfies ChainOrder;
  const r = await venueGet(url("orders?address=alice.testnet"), reader({ list_orders: [o] }));
  assert.equal(r.status, 200); assert.deepEqual(r.body, [normalizeOrder(o)]); assert.equal((r.body as ReturnType<typeof normalizeOrder>[])[0].nonce, "9007199254740993");
});
test("invalid accounts, limits and networks fail without trusting request-provided RPCs", async () => {
  const rpc = reader({});
  for (const path of ["orders?address=BAD", "fills?address=alice.testnet&limit=-1", "markets/900", "ready?network=mainnet"]) assert.equal((await venueGet(url(path), rpc)).status, 400);
});
test("stale or paused deployments never pass readiness", async () => {
  const status = { token_id: ASSETS.usdc, paused: false, model: "isolated-bilateral-capped" };
  const fresh = { price: "1000000000000000000", timestamp: Math.floor(Date.now() / 1000), paused: false };
  assert.equal((await venueGet(url("ready"), snapshotReader(status, [fresh]))).status, 200);
  assert.equal((await venueGet(url("ready"), snapshotReader(status, [{ ...fresh, timestamp: 1 }]))).status, 503);
  assert.equal((await venueGet(url("ready"), snapshotReader({ ...status, paused: true }, [fresh]))).status, 503);
  assert.equal((await venueGet(url("ready"), snapshotReader({ ...status, token_id: "wrong.testnet" }, [fresh]))).status, 503);
});
test("readiness honors shorter contract TTL and rejects future observations", async () => {
  const now = Math.floor(Date.now() / 1000);
  const status = { token_id: ASSETS.usdc, paused: false, model: "isolated-bilateral-capped" };
  const market = { price: "1", paused: false, controller: { params: { oracle_max_age_sec: 10 } } };
  for (const timestamp of [now - 11, now + 10])
    assert.equal((await venueGet(url("ready"), snapshotReader(status, [{ ...market, timestamp }]))).status, 503);
});
test("market list and detail expose zero effective rate with a fresh oracle but expired quote", async () => {
  const now = Math.floor(Date.now() / 1000);
  const market = { market_id: 1, price: "1", timestamp: now, funding_rate_ppm: 2000, funding_rate_bps: 20,
    controller: { rate_applied_at: now - 3600, fallback: false, params: { oracle_max_age_sec: 10 } } };
  const rpc = reader({ funding_snapshot: { timestamp: now, status: {}, markets: [market] }, get_trades: [] });
  for (const path of ["markets", "markets/1"]) {
    const r = await venueGet(url(path), rpc);
    const m = (Array.isArray(r.body) ? r.body[0] : r.body) as Record<string, unknown>;
    assert.equal(m.funding_rate, 0);
    assert.equal(m.stored_funding_rate_ppm, 2000);
    assert.equal(m.funding_inactive_reason, "RATE_EXPIRED");
  }
});
test("readiness cannot use wall time to accept an oracle that is future at the finalized snapshot", async t => {
  t.mock.method(Date, "now", () => 110_000);
  const status = { token_id: ASSETS.usdc, paused: false, model: "isolated-bilateral-capped" };
  const market = { price: "1", timestamp: 105, paused: false, controller: { params: { oracle_max_age_sec: 10 } } };
  const result = await venueGet(url("ready"), snapshotReader(status, [market], 100));
  assert.equal(result.status, 503);
  assert.equal((result.body as { asOf: number }).asOf, 100);
});
test("a stalled finalized snapshot cannot keep readiness or effective funding alive", async t => {
  t.mock.method(Date, "now", () => 111_000);
  const status = { token_id: ASSETS.usdc, paused: false, model: "isolated-bilateral-capped" };
  const market = { market_id: 1, price: "1", timestamp: 100, paused: false, funding_rate_ppm: 2000,
    controller: { rate_applied_at: 100, fallback: false, params: { oracle_max_age_sec: 10 } } };
  const rpc = snapshotReader(status, [market], 100);
  assert.equal((await venueGet(url("ready"), rpc)).status, 503);
  const result = await venueGet(url("markets"), rpc);
  const m = (result.body as Array<Record<string, unknown>>)[0];
  assert.equal(m.funding_as_of, 100);
  assert.equal(m.funding_rate, 0);
  assert.equal(m.funding_inactive_reason, "ORACLE_STALE");
});
test("market projections never blend controller revisions from separate view calls", async t => {
  t.mock.method(Date, "now", () => 100_000);
  const calls: string[] = [];
  const rpc: ReadContract = async <T>(method: string) => {
    calls.push(method);
    assert.equal(method, "funding_snapshot");
    return { timestamp: 100, status: {}, markets: [{ price: "1", timestamp: 100, funding_rate_ppm: 400,
      controller: { revision: 2, rate_applied_at: 100, fallback: false, params: { oracle_max_age_sec: 10 } } }] } as T;
  };
  const result = await venueGet(url("markets"), rpc);
  assert.equal((result.body as Array<{ funding_rate: number }>)[0].funding_rate, 0.0004);
  assert.deepEqual(calls, ["funding_snapshot"]);
});
test("fills never fabricate transaction hashes or convert raw integers to Number", async () => {
  const r = await venueGet(url("fills?address=alice.testnet"), reader({ get_trades: [{ id: "1", maker: "alice.testnet", price: "123456789012345678901234", size: "1000000", market_id: 1, kind: "open", block_height: "123", timestamp: 100 }] }));
  const fill = (r.body as Array<{ price: string; txHash: string }>)[0]; assert.equal(fill.price, "123456789012345678901234"); assert.equal(fill.txHash, "");
});
test("secondary settlement and unsupported period endpoints are explicit", async () => {
  assert.equal((await venueGet(url("settlements"), reader({}))).status, 410);
  assert.equal((await venueGet(url("leaderboard?period=MONTH"), reader({}))).status, 400);
  assert.equal((await venueGet(url("unknown"), reader({}))).status, 404);
});
