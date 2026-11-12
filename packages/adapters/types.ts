// PAPER prices are micro-USD/base, amounts micro-base; never chain 1e18 prices.
export const SCALE = 1_000_000n;
export type Leg = "spot" | "perp";
export type Side = "buy" | "sell";
export type Status = "pending" | "partial" | "filled" | "rejected" | "cancelled";
export interface Quote {
  mode: "PAPER"; leg: Leg; market: string; id: string; at: number; expires: number;
  price: bigint; depth: bigint; feeBps: bigint; slippageBps: bigint; available: boolean;
}
export interface OrderRequest {
  id: string; strategy: string; leg: Leg; side: Side; size: bigint;
  quote: Quote; reduceOnly: boolean; marginBps?: bigint;
}
export interface Fill {
  id: string; request: OrderRequest; revision: number; status: Status;
  filled: bigint; costs: bigint; reason: string; receipt: null;
}
export interface Observation {
  mode: "PAPER"; leg: Leg; strategy: string; at: number; available: boolean; oracleFresh: boolean;
  position: bigint; cash: bigint; margin: bigint; payerCollateral: bigint;
  realizedPnl: bigint; unrealizedPnl: bigint; equity: bigint; funding: bigint; costs: bigint; capBinding: boolean;
}
export interface Adapter {
  readonly mode: "PAPER"; readonly leg: Leg;
  quote(now: number): Promise<Quote>;
  submit(request: OrderRequest, now: number): Promise<Fill>;
  lookup(id: string): Promise<Fill | null>;
  cancel(id: string): Promise<Fill>;
  observe(now: number): Promise<Observation>;
}
export const abs = (n: bigint) => n < 0n ? -n : n;
export const value = (size: bigint, price: bigint) => (size * price + SCALE - 1n) / SCALE;
export function fresh(q: Quote, now: number): boolean {
  return q.mode === "PAPER" && /^[A-Z0-9]{1,12}\/USD$/.test(q.market) && Number.isSafeInteger(q.at) && Number.isSafeInteger(q.expires) && q.expires > q.at && q.available && Number.isSafeInteger(now) && now >= q.at && now < q.expires
    && q.price > 0n && q.depth >= 0n && q.feeBps >= 0n && q.slippageBps >= 0n
    && q.feeBps <= 10_000n && q.slippageBps <= 10_000n;
}
