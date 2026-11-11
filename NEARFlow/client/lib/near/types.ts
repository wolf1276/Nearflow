export interface ChainMarket {
  market_id: number; symbol: string; initial_margin_bps: number; maintenance_margin_bps: number;
  max_open_interest: string; open_interest: string; price: string; timestamp: number;
  last_price: string; funding_index: string; funding_rate_bps: number; paused: boolean;
}
export interface ChainOrder {
  id: string; owner: string; market_id: number; is_long: boolean; size: string;
  remaining: string; filled_size: string; limit_price: string; margin: string; nonce: string;
  expiry_ts: string; leverage: number; post_only: boolean; reduce_only: boolean; cancelled: boolean; created_at: number;
}
export interface ChainTrade {
  id: string; market_id: number; maker: string; taker: string; is_long: boolean;
  price: string; size: string; kind: "open" | "close" | "liquidation";
  maker_pnl: string; taker_pnl: string; timestamp: number; block_height: string;
}
export interface ChainFunding { id: string; market_id: number; long: string; short: string; long_payment: string; timestamp: number; }
export interface ChainAccount {
  account_id: string; available: string; last_nonce: string; orders: number[]; positions: number[];
  stats: { deposited: string; withdrawn: string; realized_pnl: string; funding: string; fees: string;
    volume: string; trades: number; wins: number; liquidations: number; };
}
export interface VenueStatus {
  name: string; version: string; network: string; paused: boolean; token_id: string; oracle_id: string;
  market_count: number; insurance: string; total_deposited: string; deposit_cap: string;
  model: string; fee_bps: number; oracle_max_age_seconds: number;
}
export interface ChainHealth {
  equity: string; initial_margin_required: string; free_collateral: string;
  margin_ratio: string; liquidatable: boolean; oracle_stale: boolean;
}
