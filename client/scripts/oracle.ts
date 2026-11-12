import { signer, read, send, chainTime, sleep } from "./near-runtime";
import { parsePrice } from "../lib/near/units";
import type { ChainMarket, VenueStatus } from "../lib/near/types";

async function json(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Feed HTTP ${response.status}`); return response.json();
}
export async function medianPrice(symbol: string): Promise<bigint> {
  const sources = await Promise.allSettled([
    json(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`).then(j => parsePrice(j.price)),
    json(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`).then(j => parsePrice(j.data.amount)),
    json(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${symbol}-USDT`).then(j => {
      if (j.code !== "200000" || Date.now() - Number(j.data.time) > 15000 || Number(j.data.time) > Date.now() + 2000) throw new Error("Stale source ticker");
      return parsePrice(j.data.price);
    }),
  ]);
  const values = sources.filter((r): r is PromiseFulfilledResult<bigint> => r.status === "fulfilled").map(r => r.value).sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
  if (values.length < 2) throw new Error(`Insufficient independent prices for ${symbol}`);
  const median = values.length === 2 ? (values[0] + values[1]) / 2n : values[1];
  if (values.some(p => (p > median ? p - median : median - p) * 10000n > median * 300n)) throw new Error(`${symbol} feed divergence exceeds 3%`);
  return median;
}
async function main() {
  const oracle = await signer("NEAR_ORACLE_KEY_FILE");
  const status = await read<VenueStatus>(oracle, "status");
  if (oracle.accountId !== status.oracle_id) throw new Error("Oracle credential is not authorized by the contract");
  const once = process.argv.includes("--once");
  do {
    let failed = false;
    const markets = await read<ChainMarket[]>(oracle, "get_markets");
    for (const m of markets) {
      try {
        const price = await medianPrice(m.symbol), timestamp = await chainTime(oracle);
        if (timestamp <= m.timestamp) continue;
        await send(oracle, "publish_price", { market_id: m.market_id, price: price.toString(), timestamp });
        console.log(`Published ${m.symbol} at ${timestamp}`);
      } catch (error) { failed = true; console.error(error instanceof Error ? error.message : String(error)); }
    }
    if (once && failed) process.exitCode = 1;
    if (!once) await sleep(10000);
  } while (!once);
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
