import { signer, read, send, chainTime, sleep } from "./near-runtime";
import type { ChainMarket, ChainOrder } from "../lib/near/types";
async function main() {
  const keeper = await signer(process.env.NEAR_KEEPER_KEY_FILE ? "NEAR_KEEPER_KEY_FILE" : "NEAR_ORACLE_KEY_FILE");
  const registration = await read(keeper, "storage_balance_of", { account_id: keeper.accountId });
  if (!registration) throw new Error("Register the keeper's vault storage before running liquidations");
  const once = process.argv.includes("--once"); let lastFunding = 0;
  async function attempt(method: string, args: object) {
    try { await send(keeper, method, args); }
    catch (error) { console.error(`${method}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  do {
    const now = await chainTime(keeper);
    const orders = await read<ChainOrder[]>(keeper, "get_orders", { market_id: null });
    for (const o of orders.filter(o => Number(o.expiry_ts) <= now)) await attempt("expire_order", { order_id: o.id });
    const markets = await read<ChainMarket[]>(keeper, "get_markets");
    for (const m of markets) {
      if (m.paused || now - m.timestamp > 60) continue;
      const candidate = await read<{ maker_id: string; taker_id: string } | null>(keeper, "match_candidate", { market_id: m.market_id });
      if (candidate) await attempt("match_orders", candidate);
    }
    for (const id of await read<string[]>(keeper, "liquidatable_pairs")) await attempt("liquidate", { position_id: id });
    if (now - lastFunding >= 60) {
      for (const p of await read<Array<{ id: string; market_id: number }>>(keeper, "get_pairs")) {
        const m = markets.find(m => m.market_id === p.market_id);
        if (m && now - m.timestamp <= 60) await attempt("settle_funding", { position_id: p.id });
      }
      lastFunding = now;
    }
    const audit = await read<{ balanced: boolean }>(keeper, "audit");
    if (!audit.balanced) throw new Error("Custody invariant violated: stop the venue and investigate");
    if (!once) await sleep(5000);
  } while (!once);
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
