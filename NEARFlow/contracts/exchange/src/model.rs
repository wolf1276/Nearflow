use near_sdk::{
    AccountId,
    json_types::{I128, U64, U128},
    near,
};

pub const MAX_ORDERS: usize = 16;
pub const MAX_POSITIONS: usize = 32;
pub const MAX_HISTORY: usize = 32;
pub const MAX_GLOBAL_ORDERS: u64 = 256;
pub const MAX_GLOBAL_POSITIONS: u64 = 256;
pub const HISTORY_RING: u64 = 512;
pub const PRICE_SCALE: u128 = 1_000_000_000_000_000_000;
pub const MAX_PRICE: u128 = 1_000_000_000_000_000_000_000_000_000;
pub const ORACLE_MAX_AGE: u64 = 60;

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Stats {
    pub deposited: U128,
    pub withdrawn: U128,
    pub realized_pnl: I128,
    pub funding: I128,
    pub fees: U128,
    pub volume: U128,
    pub trades: u32,
    pub wins: u32,
    pub liquidations: u32,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Account {
    pub account_id: AccountId,
    pub available: U128,
    pub last_nonce: U64,
    pub orders: Vec<u64>,
    pub positions: Vec<u64>,
    pub history: Vec<Order>,
    pub stats: Stats,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Market {
    pub market_id: u32,
    pub symbol: String,
    pub initial_margin_bps: u32,
    pub maintenance_margin_bps: u32,
    pub max_open_interest: U128,
    pub price: U128,
    pub timestamp: u64,
    pub last_price: U128,
    pub funding_index: I128,
    /// Display compatibility only; authoritative rate is funding_rate_ppm.
    pub funding_rate_bps: i32,
    pub funding_rate_ppm: i64,
    pub controller: FundingController,
    pub funding_updated_at: u64,
    pub open_interest: U128,
    pub paused: bool,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct FundingController {
    pub mode: nearflow_funding::Mode,
    pub params: nearflow_funding::Params,
    pub revision: u32,
    pub last_epoch: Option<u64>,
    pub rate_applied_at: u64,
    pub premium_ema_ppm: Option<i64>,
    pub fallback: bool,
}
impl Default for FundingController {
    fn default() -> Self {
        Self {
            mode: nearflow_funding::Mode::Baseline,
            params: Default::default(),
            revision: 1,
            last_epoch: None,
            rate_applied_at: 0,
            premium_ema_ppm: None,
            fallback: true,
        }
    }
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Order {
    pub strategy_id: Option<U64>,
    pub id: U64,
    pub owner: AccountId,
    pub market_id: u32,
    pub is_long: bool,
    pub size: U128,
    pub remaining: U128,
    pub filled_size: U128,
    pub limit_price: U128,
    pub margin: U128,
    pub nonce: U64,
    pub expiry_ts: U64,
    pub leverage: u32,
    pub post_only: bool,
    pub reduce_only: bool,
    pub cancelled: bool,
    pub created_at: u64,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Pair {
    pub long_strategy_id: Option<U64>,
    pub short_strategy_id: Option<U64>,
    pub id: U64,
    pub market_id: u32,
    pub long: AccountId,
    pub short: AccountId,
    pub size: U128,
    pub entry_price: U128,
    pub long_margin: U128,
    pub short_margin: U128,
    pub last_funding_index: I128,
    pub funding_remainder: I128,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Trade {
    pub maker_strategy_id: Option<U64>,
    pub taker_strategy_id: Option<U64>,
    pub id: U64,
    pub market_id: u32,
    pub maker: AccountId,
    pub taker: AccountId,
    pub is_long: bool,
    pub price: U128,
    pub size: U128,
    pub kind: String,
    pub maker_pnl: I128,
    pub taker_pnl: I128,
    pub timestamp: u64,
    pub block_height: U64,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Funding {
    pub long_strategy_id: Option<U64>,
    pub short_strategy_id: Option<U64>,
    pub id: U64,
    pub market_id: u32,
    pub long: AccountId,
    pub short: AccountId,
    pub long_payment: I128,
    pub timestamp: u64,
}
#[near(serializers = [json])]
pub struct PositionView {
    pub strategy_id: Option<U64>,
    pub position_id: U64,
    pub owner: AccountId,
    pub counterparty: AccountId,
    pub market_id: u32,
    pub size: U128,
    pub entry_price: U128,
    pub margin: U128,
    pub is_long: bool,
    pub last_funding_index: I128,
    pub unrealized_pnl: I128,
    pub liquidatable: bool,
    pub liquidation_price: U128,
}
#[near(serializers = [json])]
pub struct Health {
    pub equity: U128,
    pub initial_margin_required: U128,
    pub free_collateral: U128,
    pub margin_ratio: U128,
    pub liquidatable: bool,
    pub oracle_stale: bool,
}
#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}
#[near(serializers = [json])]
pub struct StorageBounds {
    pub min: U128,
    pub max: Option<U128>,
}
#[near(serializers = [json])]
pub struct Collateral {
    pub oracle_symbol: String,
    pub haircut_bps: u16,
    pub active: bool,
}
#[near(serializers = [json])]
pub struct BookLevel {
    pub price: String,
    pub size: String,
}
#[near(serializers = [json])]
pub struct OrderBook {
    pub bids: Vec<BookLevel>,
    pub asks: Vec<BookLevel>,
    pub timestamp: u64,
}
