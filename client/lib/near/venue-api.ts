import { CONTRACTS, ASSETS } from "@/config";
import { isAccountId } from "./account";
import { view } from "./rpc";
import { fundingView, oracleFresh, oracleExpiresAt } from "./funding";
import type { ChainAccount, ChainFunding, ChainHealth, ChainOrder, ChainTrade, FundingSnapshot } from "./types";

const usd = (v: string) => Number(v) / 1e6;
export type ReadContract = <T>(method: string, args?: Record<string, unknown>) => Promise<T>;
const read: ReadContract = (method, args) => view(CONTRACTS.engine, method, args);
export function normalizeOrder(o: ChainOrder) {
  return { owner: o.owner, marketId: o.market_id, isLong: o.is_long, nonce: o.nonce,
    size: o.size, limitPrice: o.limit_price, reduceOnly: o.reduce_only, expiryTs: o.expiry_ts,
    cancelled: o.cancelled || Number(o.expiry_ts) <= Date.now() / 1000 && BigInt(o.remaining) > 0n,
    filledSize: o.filled_size, createdAt: o.created_at, leverage: o.leverage };
}
function account(value: string | null): string {
  if (!value || !isAccountId(value)) throw new Error("BAD_ACCOUNT"); return value;
}
function limit(q: URLSearchParams, fallback = 50, max = 512) {
  const n = Number(q.get("limit") ?? fallback); if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error("BAD_LIMIT"); return n;
}
/** Read-only projections from finalized contract state, with an injectable reader for tests. */
export async function venueGet(url: URL, rpc: ReadContract = read): Promise<{ status: number; body: unknown }> {
  const q = url.searchParams, path = url.pathname.replace(/^\/api\//, "").split("/");
  const ok = (body: unknown) => ({ status: 200, body });
  if (q.has("network") && q.get("network") !== "testnet") return { status: 400, body: { error: "Only NEAR testnet is supported" } };
  try {
    if (path[0] === "health" || path[0] === "ready") {
      const { timestamp, status, markets } = await rpc<FundingSnapshot>("funding_snapshot");
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("Invalid snapshot time");
      const observedAt = Math.floor(Date.now() / 1000);
      const fresh = markets.length > 0 && markets.every(m => oracleFresh(m, timestamp) && oracleFresh(m, observedAt) && !m.paused);
      const tokenMatches = status.token_id === ASSETS.usdc;
      const ready = !status.paused && fresh && tokenMatches && status.model === "isolated-bilateral-capped";
      return { status: path[0] === "ready" && !ready ? 503 : 200,
        body: { ...status, ready, oracleFresh: fresh, tokenMatches, configuredToken: ASSETS.usdc, asOf: timestamp,
          readyUntil: markets.length ? Math.min(...markets.map(oracleExpiresAt)) : null } };
    }
    if (path[0] === "markets") {
      if (!path[1]) {
        const snapshot = await rpc<FundingSnapshot>("funding_snapshot");
        if (!Number.isSafeInteger(snapshot.timestamp) || snapshot.timestamp < 0) throw new Error("Invalid snapshot time");
        const observedAt = Math.floor(Date.now() / 1000);
        return ok(snapshot.markets.map(m => ({ ...m, ...fundingView(m, snapshot.timestamp, observedAt) })));
      }
      const market_id = Number(path[1]); if (!Number.isSafeInteger(market_id) || market_id < 1 || market_id > 8) throw new Error("BAD_MARKET");
      if (path[2] === "orderbook") return ok(await rpc("orderbook", { market_id }));
      const trades = await rpc<ChainTrade[]>("get_trades", { market_id, limit: 512 });
      if (path[2] === "trades") return ok(trades.filter(t => t.kind === "open").slice(0, limit(q)).map(t => ({
        price: String(Number(t.price) / 1e18), size: String(usd(t.size)), side: t.is_long ? "buy" : "sell", timestamp: t.timestamp * 1000,
      })));
      if (path[2] === "candles") {
        const buckets = new Map<number, { time: number; open: number; high: number; low: number; close: number; volume: number }>();
        for (const t of [...trades].reverse()) {
          if (t.kind !== "open") continue;
          const time = Math.floor(t.timestamp / 60) * 60, price = Number(t.price) / 1e18;
          const c = buckets.get(time) ?? { time, open: price, high: price, low: price, close: price, volume: 0 };
          c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; c.volume += usd(t.size); buckets.set(time, c);
        }
        return ok([...buckets.values()]);
      }
      if (path[2]) return { status: 404, body: { error: "Unknown market endpoint" } };
      const snapshot = await rpc<FundingSnapshot>("funding_snapshot");
      if (!Number.isSafeInteger(snapshot.timestamp) || snapshot.timestamp < 0) throw new Error("Invalid snapshot time");
      const m = snapshot.markets.find(m => m.market_id === market_id);
      if (!m) return { status: 404, body: { error: "Market not configured" } };
      const recent = trades.filter(t => t.kind === "open" && Date.now() / 1000 - t.timestamp < 86400);
      const volume = recent.reduce((v, t) => v + BigInt(t.size) * BigInt(t.price) / 10n ** 18n, 0n);
      return ok({ ...m, last_price: m.last_price, long_open_interest: m.open_interest, short_open_interest: m.open_interest,
        volume: volume.toString(), historyWindow: "latest-512-events", ...fundingView(m, snapshot.timestamp, Math.floor(Date.now() / 1000)) });
    }
    if (path[0] === "orders") {
      if (path[1] && path[1] !== "list") return { status: 405, body: { error: "Authorize order changes directly in your NEAR wallet" } };
      const owner = account(q.get("address"));
      return ok((await rpc<ChainOrder[]>("list_orders", { account_id: owner })).map(normalizeOrder));
    }
    if (path[0] === "positions") return ok(await rpc("positions", { account_id: account(q.get("address")) }));
    if (path[0] === "fills") {
      const owner = account(q.get("address"));
      const trades = await rpc<ChainTrade[]>("get_trades", { account_id: owner, limit: limit(q) });
      const since = Number(q.get("since") ?? 0);
      return ok(trades.filter(t => t.timestamp * 1000 >= since).map(t => ({ id: t.id, marketId: t.market_id, isMaker: t.maker === owner,
        price: t.price, size: t.size, txHash: "", blockHeight: t.block_height, kind: t.kind, createdAt: t.timestamp * 1000 })));
    }
    if (path[0] === "funding") {
      const owner = account(q.get("address"));
      const rows = await rpc<ChainFunding[]>("get_funding", { account_id: owner, limit: limit(q) });
      return ok(rows.map(f => ({ marketId: f.market_id, amount: usd(f.long_payment) * (f.long === owner ? 1 : -1), txHash: "", createdAt: f.timestamp * 1000 })));
    }
    if (path[0] === "portfolio") {
      const owner = account(path[1]);
      const [a, trades, funding] = await Promise.all([
        rpc<ChainAccount | null>("get_account", { account_id: owner }),
        rpc<ChainTrade[]>("get_trades", { account_id: owner, limit: 512 }), rpc<ChainFunding[]>("get_funding", { account_id: owner, limit: 512 }),
      ]);
      const s = a?.stats;
      return ok({ analytics: s ? { realizedPnl: usd(s.realized_pnl), volume: usd(s.volume), tradeCount: s.trades,
        winRate: s.trades ? s.wins / s.trades : 0, totalDeposited: usd(s.deposited), totalWithdrawn: usd(s.withdrawn),
        totalFundingPaid: usd(s.funding), totalFeesPaid: usd(s.fees), liquidationCount: s.liquidations } : null,
        equityCurve: [], balanceHistory: [], historyWindow: "latest-512-events",
        pnlHistory: trades.filter(t => t.kind !== "open").map(t => ({ kind: t.kind, amount: usd(t.maker === owner ? t.maker_pnl : t.taker_pnl),
          size: usd(t.size), price: Number(t.price) / 1e18, marketId: t.market_id, at: new Date(t.timestamp * 1000).toISOString() })),
        fundingHistory: funding.map(f => ({ marketId: f.market_id, amount: usd(f.long_payment) * (f.long === owner ? 1 : -1), at: new Date(f.timestamp * 1000).toISOString() })),
      });
    }
    if (path[0] === "leaderboard") {
      if (q.has("period") && q.get("period") !== "ALL") return { status: 400, body: { error: "Only lifetime statistics are available" } };
      const all: ChainAccount[] = [];
      for (let offset = 0; offset < 1000; offset += 100) {
        const batch = await rpc<ChainAccount[]>("get_accounts", { from_index: offset, limit: 100 }); all.push(...batch); if (batch.length < 100) break;
      }
      const net = (a: ChainAccount) => BigInt(a.stats.realized_pnl) + BigInt(a.stats.funding) - BigInt(a.stats.fees);
      const filtered = all.filter(a => a.account_id.includes(q.get("search")?.toLowerCase() ?? "")).sort((a, b) => net(a) > net(b) ? -1 : net(a) < net(b) ? 1 : a.account_id.localeCompare(b.account_id));
      const offset = Number(q.get("offset") ?? 0); if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("BAD_OFFSET");
      const traders = await Promise.all(filtered.slice(offset, offset + limit(q, 10, 100)).map(async (a, i) => {
        const h = await rpc<ChainHealth>("account_health", { account_id: a.account_id, token_id: ASSETS.usdc });
        return { rank: offset + i + 1, address: a.account_id, pnl: Number(net(a)) / 1e6, volume: usd(a.stats.volume),
          roi: usd(a.stats.deposited) ? Number(net(a)) / Number(a.stats.deposited) * 100 : 0,
          winRate: a.stats.trades ? a.stats.wins / a.stats.trades : 0, tradeCount: a.stats.trades,
          liquidations: a.stats.liquidations, accountValue: usd(h.equity) };
      }));
      return ok({ period: "ALL", metric: "pnl", total: filtered.length, traders });
    }
    if (path[0] === "settlements") return { status: 410, body: { error: "NEAR settlement is atomic; no secondary authorization endpoint" } };
    return { status: 404, body: { error: "Unknown API endpoint" } };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("BAD_")) return { status: 400, body: { error: error.message } };
    console.error("NEARFlow view failed:", error);
    return { status: 503, body: { error: "NEAR contract is unconfigured or RPC is unavailable", code: "RPC_UNAVAILABLE" } };
  }
}
