import { CONTRACTS } from "@/config";
import { view } from "./rpc";
export async function getOraclePrice(symbol: string): Promise<{ price: bigint; timestamp: number } | null> {
  const p = await view<{ price: string; timestamp: number } | null>(CONTRACTS.oracleAdapter, "get_price", { symbol });
  if (!p || p.timestamp > Date.now() / 1000 + 5 || Date.now() / 1000 - p.timestamp > 60) return null;
  return { price: BigInt(p.price), timestamp: p.timestamp };
}
