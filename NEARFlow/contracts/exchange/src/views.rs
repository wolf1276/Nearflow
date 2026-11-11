use crate::ExchangeExt;
use crate::*;
use std::collections::BTreeMap;

#[near]
impl Exchange {
    pub fn status(&self) -> near_sdk::serde_json::Value {
        json!({"name":"NEARFlow", "version":"1.0.0", "network":"testnet", "paused":self.paused,
            "token_id":self.token_id, "oracle_id":self.oracle_id, "market_count":self.markets.len(),
            "insurance":U128(self.insurance), "total_deposited":U128(self.total), "deposit_cap":U128(self.cap),
            "model":"isolated-bilateral-capped", "fee_bps":3, "oracle_max_age_seconds":ORACLE_MAX_AGE})
    }
    pub fn get_markets(&self) -> Vec<Market> {
        self.markets
            .iter()
            .map(|(_, mut m)| {
                m.funding_index = I128(funding_index(&m, now()));
                m
            })
            .collect()
    }
    pub fn get_market(&self, market_id: u32) -> Market {
        let mut m = self.market(market_id);
        m.funding_index = I128(funding_index(&m, now()));
        m
    }
    pub fn get_price(&self, symbol: String) -> Option<near_sdk::serde_json::Value> {
        if symbol == "USDC" {
            return Some(json!({"price":U128(PRICE_SCALE),"timestamp":now()}));
        }
        self.markets
            .iter()
            .find(|(_, m)| m.symbol == symbol)
            .map(|(_, m)| json!({"price":m.price,"timestamp":m.timestamp}))
    }
    pub fn get_account(&self, account_id: AccountId) -> Option<Account> {
        self.accounts.get(&account_id)
    }
    pub fn get_accounts(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Account> {
        self.accounts
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(_, a)| a)
            .collect()
    }
    pub fn next_nonce(&self, account_id: AccountId) -> U64 {
        U64(self.account(&account_id).last_nonce.0 + 1)
    }
    pub fn list_orders(&self, account_id: AccountId) -> Vec<Order> {
        let Some(a) = self.accounts.get(&account_id) else {
            return vec![];
        };
        let mut result = a.history;
        for id in a.orders {
            let o = self.orders.get(&id).unwrap();
            result.retain(|v| v.nonce != o.nonce);
            result.push(o);
        }
        result.sort_by_key(|o| o.id.0);
        result
    }
    pub fn get_orders(&self, market_id: Option<u32>) -> Vec<Order> {
        self.orders
            .iter()
            .filter(|(_, o)| market_id.is_none_or(|id| o.market_id == id))
            .map(|(_, o)| o)
            .collect()
    }
    pub fn is_cancelled(&self, account_id: AccountId, nonce: U64) -> bool {
        self.list_orders(account_id).iter().any(|o| {
            o.nonce == nonce && (o.cancelled || o.expiry_ts.0 <= now() && o.remaining.0 > 0)
        })
    }
    pub fn filled(&self, account_id: AccountId, nonce: U64) -> U128 {
        self.list_orders(account_id)
            .iter()
            .find(|o| o.nonce == nonce)
            .map(|o| o.filled_size)
            .unwrap_or(U128(0))
    }
    pub fn open_interest(&self, market_id: u32) -> near_sdk::serde_json::Value {
        let oi = self.market(market_id).open_interest;
        json!({"long":oi,"short":oi})
    }
    pub fn positions(&self, account_id: AccountId) -> Vec<PositionView> {
        let Some(a) = self.accounts.get(&account_id) else {
            return vec![];
        };
        a.positions
            .iter()
            .map(|id| {
                let mut p = self.pairs.get(id).unwrap();
                let m = self.market(p.market_id);
                let index = funding_index(&m, now());
                let (long, short) = funded_margins(&p, index);
                p.long_margin = U128(long);
                p.short_margin = U128(short);
                let is_long = account_id == p.long;
                let risk = is_liquidatable(&p, &m);
                let (_, _, pnl) = payout(&p, m.price.0);
                PositionView {
                    position_id: p.id,
                    owner: account_id.clone(),
                    counterparty: if is_long {
                        p.short.clone()
                    } else {
                        p.long.clone()
                    },
                    market_id: p.market_id,
                    size: p.size,
                    entry_price: p.entry_price,
                    margin: U128(if is_long { long } else { short }),
                    is_long,
                    last_funding_index: I128(index),
                    unrealized_pnl: I128(if is_long { pnl } else { -pnl }),
                    liquidatable: if is_long { risk.0 } else { risk.1 },
                    liquidation_price: U128(liquidation_price(&p, &m, is_long)),
                }
            })
            .collect()
    }
    pub fn account_health(&self, account_id: AccountId, token_id: AccountId) -> Health {
        self.assert_token(&token_id);
        let Some(a) = self.accounts.get(&account_id) else {
            return Health {
                equity: U128(0),
                initial_margin_required: U128(0),
                free_collateral: U128(0),
                margin_ratio: U128(0),
                liquidatable: false,
                oracle_stale: false,
            };
        };
        let reserved: u128 = a
            .orders
            .iter()
            .map(|id| self.orders.get(id).unwrap().margin.0)
            .sum();
        let mut equity = a.available.0 + reserved;
        let mut locked = reserved;
        let mut maintenance = 0;
        let mut liquidatable = false;
        let mut stale = false;
        for p in self.positions(account_id) {
            equity += (p.margin.0 as i128 + p.unrealized_pnl.0).max(0) as u128;
            locked += p.margin.0;
            let m = self.market(p.market_id);
            maintenance += mul_div(
                notional(p.size.0, m.price.0),
                m.maintenance_margin_bps as u128,
                10_000,
            )
            .max(1);
            stale |= now().saturating_sub(m.timestamp) > ORACLE_MAX_AGE;
            liquidatable |= p.liquidatable;
        }
        Health {
            equity: U128(equity),
            initial_margin_required: U128(locked),
            free_collateral: a.available,
            margin_ratio: U128(if maintenance == 0 {
                100 * PRICE_SCALE
            } else {
                mul_div(equity, PRICE_SCALE, maintenance)
            }),
            liquidatable,
            oracle_stale: stale,
        }
    }
    pub fn orderbook(&self, market_id: u32) -> OrderBook {
        let mut bids = BTreeMap::<u128, u128>::new();
        let mut asks = BTreeMap::<u128, u128>::new();
        for (_, o) in self
            .orders
            .iter()
            .filter(|(_, o)| o.market_id == market_id && o.expiry_ts.0 > now())
        {
            let book = if o.is_long { &mut bids } else { &mut asks };
            *book.entry(o.limit_price.0).or_default() += o.remaining.0;
        }
        OrderBook {
            bids: bids
                .into_iter()
                .rev()
                .map(|(p, s)| BookLevel {
                    price: decimal(p, 18),
                    size: decimal(s, 6),
                })
                .collect(),
            asks: asks
                .into_iter()
                .map(|(p, s)| BookLevel {
                    price: decimal(p, 18),
                    size: decimal(s, 6),
                })
                .collect(),
            timestamp: now() * 1000,
        }
    }
    pub fn get_trades(
        &self,
        market_id: Option<u32>,
        account_id: Option<AccountId>,
        limit: Option<u32>,
    ) -> Vec<Trade> {
        (self.next_trade.saturating_sub(HISTORY_RING)..self.next_trade)
            .rev()
            .filter_map(|id| self.trades.get(&(id % HISTORY_RING)))
            .filter(|t| {
                market_id.is_none_or(|id| t.market_id == id)
                    && account_id
                        .as_ref()
                        .is_none_or(|id| id == &t.maker || id == &t.taker)
            })
            .take(limit.unwrap_or(50).min(HISTORY_RING as u32) as usize)
            .collect()
    }
    pub fn get_funding(&self, account_id: AccountId, limit: Option<u32>) -> Vec<Funding> {
        (self.next_funding.saturating_sub(HISTORY_RING)..self.next_funding)
            .rev()
            .filter_map(|id| self.funding.get(&(id % HISTORY_RING)))
            .filter(|f| f.long == account_id || f.short == account_id)
            .take(limit.unwrap_or(50).min(HISTORY_RING as u32) as usize)
            .collect()
    }
    pub fn match_candidate(&self, market_id: u32) -> Option<near_sdk::serde_json::Value> {
        let m = self.market(market_id);
        if self.paused || m.paused || now().saturating_sub(m.timestamp) > ORACLE_MAX_AGE {
            return None;
        }
        let mut orders: Vec<Order> = self
            .orders
            .iter()
            .map(|(_, o)| o)
            .filter(|o| o.market_id == market_id && o.expiry_ts.0 > now())
            .collect();
        orders.sort_by_key(|o| o.id.0);
        for taker in orders {
            if let Some(maker) = self.best_cross(&taker, &m) {
                if m.open_interest.0 + maker.remaining.0.min(taker.remaining.0)
                    <= m.max_open_interest.0
                {
                    return Some(json!({"maker_id":maker.id,"taker_id":taker.id}));
                }
            }
        }
        None
    }
    pub fn get_pairs(&self) -> Vec<Pair> {
        self.pairs.iter().map(|(_, p)| p).collect()
    }
    pub fn liquidatable_pairs(&self) -> Vec<U64> {
        self.pairs
            .iter()
            .filter_map(|(_, mut p)| {
                let m = self.market(p.market_id);
                if now().saturating_sub(m.timestamp) > ORACLE_MAX_AGE {
                    return None;
                }
                let (long, short) = funded_margins(&p, funding_index(&m, now()));
                p.long_margin = U128(long);
                p.short_margin = U128(short);
                let risk = is_liquidatable(&p, &m);
                (risk.0 || risk.1).then_some(p.id)
            })
            .collect()
    }
    /// Accounting invariant includes in-flight transfers. Must equal custody total.
    pub fn audit(&self) -> near_sdk::serde_json::Value {
        let free: u128 = self.accounts.iter().map(|(_, a)| a.available.0).sum();
        let orders: u128 = self.orders.iter().map(|(_, o)| o.margin.0).sum();
        let positions: u128 = self
            .pairs
            .iter()
            .map(|(_, p)| p.long_margin.0 + p.short_margin.0)
            .sum();
        let liabilities = free + orders + positions + self.insurance + self.pending_withdrawals;
        json!({"custody":U128(self.total),"liabilities":U128(liabilities),"free":U128(free),"orders":U128(orders),
            "positions":U128(positions),"insurance":U128(self.insurance),"pending_withdrawals":U128(self.pending_withdrawals),"balanced":liabilities==self.total})
    }
}
fn decimal(value: u128, decimals: u32) -> String {
    let scale = 10u128.pow(decimals);
    let whole = value / scale;
    let fraction = value % scale;
    if fraction == 0 {
        return whole.to_string();
    }
    format!("{}.{:0width$}", whole, fraction, width = decimals as usize)
        .trim_end_matches('0')
        .to_string()
}
