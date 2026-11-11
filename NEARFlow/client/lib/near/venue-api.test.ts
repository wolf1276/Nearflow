import test from "node:test";
import assert from "node:assert/strict";
import { venueGet, normalizeOrder, type ReadContract } from "./venue-api";
import { ASSETS } from "@/config";
import type { ChainOrder } from "./types";
const url = (path: string) => new URL(`https://nearflow.example/api/${path}`);
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
  assert.equal((await venueGet(url("ready"), reader({ status, get_markets: [fresh] }))).status, 200);
  assert.equal((await venueGet(url("ready"), reader({ status, get_markets: [{ ...fresh, timestamp: 1 }] }))).status, 503);
  assert.equal((await venueGet(url("ready"), reader({ status: { ...status, paused: true }, get_markets: [fresh] }))).status, 503);
  assert.equal((await venueGet(url("ready"), reader({ status: { ...status, token_id: "wrong.testnet" }, get_markets: [fresh] }))).status, 503);
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
