"use client";
import { useEffect } from "react";
import { useMarketStore } from "@/stores/market";
import { getOraclePrice } from "@/lib/near/oracle";
import { fetchOrderBook, fetchRecentTrades } from "@/lib/market/matcher";
import { ACTIVE_MARKETS, PRICE_PRECISION, type MarketConfig } from "@/config";
import { apiFetch } from "@/lib/api";

export function MarketDataProvider({ market, children }: { market: MarketConfig; children: React.ReactNode }) {
  useEffect(() => {
    let stopped = false, busy = false;
    async function poll() {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        await Promise.all(Object.values(ACTIVE_MARKETS).map(async m => {
          const oracle = await getOraclePrice(m.oracleSymbol).catch(() => null);
          if (!stopped) useMarketStore.getState().setMarkPrice(m.marketId, oracle?.price ?? 0n);
        }));
        const [book, trades, statsResponse] = await Promise.all([
          fetchOrderBook(market.marketId), fetchRecentTrades(market.marketId), apiFetch(`/api/markets/${market.marketId}`),
        ]);
        if (stopped) return;
        const store = useMarketStore.getState(); store.setOrderBook(market.marketId, book); store.setTrades(market.marketId, trades);
        if (statsResponse.ok) {
          const s = await statsResponse.json();
          if (!stopped) store.setMarketStats(market.marketId, { lastPrice: BigInt(s.last_price), volume: BigInt(s.volume), longOI: BigInt(s.long_open_interest), shortOI: BigInt(s.short_open_interest) });
        }
      } catch { /* Leave missing venue data unavailable, never substitute spot execution prices. */ }
      finally { busy = false; }
    }
    // Spot ticker is presentation-only (24h statistics), never the settlement mark.
    async function ticker() {
      try {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${market.priceSourceSymbol}`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const t = await r.json(); if (stopped) return;
        const high = Number(t.highPrice), low = Number(t.lowPrice), change = Number(t.priceChangePercent);
        if (![high, low, change].every(Number.isFinite)) return;
        const store = useMarketStore.getState(); store.setPriceChangePct(market.marketId, change);
        store.setTicker24h(market.marketId, { highPrice: BigInt(Math.round(high * Number(PRICE_PRECISION))), lowPrice: BigInt(Math.round(low * Number(PRICE_PRECISION))), changePct: change });
      } catch { /* External reference statistics are optional. */ }
    }
    void poll(); void ticker();
    const timer = setInterval(poll, 3000), tickerTimer = setInterval(ticker, 30000);
    return () => { stopped = true; clearInterval(timer); clearInterval(tickerTimer); };
  }, [market.marketId, market.oracleSymbol, market.priceSourceSymbol]);
  return <>{children}</>;
}
