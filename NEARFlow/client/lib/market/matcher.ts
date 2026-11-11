"use client";
import type { OrderIntent } from "./order-intent";
import { apiFetch } from "@/lib/api";
import { CONTRACTS, ASSETS } from "@/config";
import { call } from "@/lib/near/wallet";
import { view } from "@/lib/near/rpc";
import type { ChainMarket, VenueStatus } from "@/lib/near/types";

export async function submitOrder(intent: OrderIntent): Promise<{ ok: boolean; error?: string }> {
  try {
    const [status, market, chainNonce] = await Promise.all([
      view<VenueStatus>(CONTRACTS.engine, "status"),
      view<ChainMarket>(CONTRACTS.engine, "get_market", { market_id: intent.marketId }),
      view<string>(CONTRACTS.engine, "next_nonce", { account_id: intent.owner }),
    ]);
    if (status.token_id !== ASSETS.usdc || status.model !== "isolated-bilateral-capped") throw new Error("Deployment token or settlement model does not match this desk");
    if (Date.now() / 1000 - market.timestamp > 60 || BigInt(market.price) <= 0n) throw new Error("Oracle stale: wait for a fresh on-chain price");
    if ((status.paused || market.paused) && !intent.reduceOnly) throw new Error("Trading is paused");
    if ((intent.leverage ?? 1) > Math.floor(10000 / market.initial_margin_bps)) throw new Error("Leverage exceeds the on-chain market limit");
    intent.nonce = BigInt(chainNonce) > intent.nonce ? BigInt(chainNonce) : intent.nonce;
    await call(CONTRACTS.orderGateway, "place_order", {
      market_id: intent.marketId, is_long: intent.isLong, size: intent.size.toString(), limit_price: intent.limitPrice.toString(),
      nonce: intent.nonce.toString(), expiry_ts: intent.expiryTs.toString(), leverage: intent.leverage ?? 1,
      reduce_only: intent.reduceOnly, post_only: intent.postOnly ?? false, immediate_or_cancel: intent.immediateOrCancel ?? false,
    }, "1", intent.owner, "250000000000000");
    return { ok: true };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
export async function fetchOrderBook(marketId: number): Promise<OrderBook | null> {
  try { const r = await apiFetch(`/api/markets/${marketId}/orderbook`); return r.ok ? r.json() : null; } catch { return null; }
}
export async function fetchRecentTrades(marketId: number): Promise<RecentTrade[]> {
  try { const r = await apiFetch(`/api/markets/${marketId}/trades`); return r.ok ? r.json() : []; } catch { return []; }
}
export interface OrderBookLevel { price: string; size: string; }
export interface OrderBook { bids: OrderBookLevel[]; asks: OrderBookLevel[]; timestamp: number; }
export interface RecentTrade { price: string; size: string; side: "buy" | "sell" | null; timestamp: number; }
