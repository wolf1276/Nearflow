use crate::ExchangeExt;
use crate::*;

#[near]
impl Exchange {
    #[payable]
    pub fn place_order(
        &mut self,
        market_id: u32,
        is_long: bool,
        size: U128,
        limit_price: U128,
        nonce: U64,
        expiry_ts: U64,
        leverage: u32,
        reduce_only: bool,
        post_only: bool,
        immediate_or_cancel: bool,
    ) -> Order {
        self.place_book_order(None, market_id, is_long, size, limit_price, nonce, expiry_ts, leverage, reduce_only, post_only, immediate_or_cancel)
    }
    #[payable]
    pub fn place_strategy_order(&mut self, strategy_id: U64, is_long: bool, size: U128, limit_price: U128, nonce: U64, expiry_ts: U64, leverage: u32, reduce_only: bool, post_only: bool, immediate_or_cancel: bool) -> Order {
        let s = self.owned_strategy(strategy_id);
        assert!(!s.closed && (!s.paused || reduce_only), "Strategy paused or closed");
        self.place_book_order(Some(strategy_id), s.market_id, is_long, size, limit_price, nonce, expiry_ts, leverage, reduce_only, post_only, immediate_or_cancel)
    }
}
impl Exchange {
    fn place_book_order(&mut self, strategy_id: Option<U64>, market_id: u32, is_long: bool, size: U128, limit_price: U128, nonce: U64, expiry_ts: U64, leverage: u32, reduce_only: bool, post_only: bool, immediate_or_cancel: bool) -> Order {
        assert_one_yocto();
        let m = self.fresh_market(market_id);
        assert!(!self.paused && !m.paused || reduce_only, "Trading paused");
        assert!(
            size.0 > 0 && size.0 <= 1_000_000_000_000_000,
            "Invalid size"
        );
        assert!(
            limit_price.0 > 0 && limit_price.0 <= MAX_PRICE,
            "Invalid limit price"
        );
        assert!(
            leverage > 0 && leverage <= 10_000 / m.initial_margin_bps,
            "Leverage exceeds market cap"
        );
        assert!(
            expiry_ts.0 > now() && expiry_ts.0 <= now() + 86_400,
            "Invalid order expiry"
        );
        assert!(
            !(post_only && immediate_or_cancel),
            "Post-only cannot be IOC"
        );
        let owner = env::predecessor_account_id();
        self.prune_account_orders(&owner, strategy_id);
        let mut a = self.trading_account(&owner, strategy_id);
        assert!(nonce.0 > a.last_nonce.0, "Nonce already used");
        assert!(
            a.orders.len() < MAX_ORDERS && self.orders.len() < MAX_GLOBAL_ORDERS,
            "Order capacity reached"
        );
        assert!(
            reduce_only || a.positions.len() < MAX_POSITIONS,
            "Position capacity reached"
        );
        a.last_nonce = nonce;
        self.save_trading_account(strategy_id, &a);
        let reserve_price = if is_long {
            limit_price.0.min(m.price.0 * 105 / 100)
        } else {
            m.price.0 * 105 / 100
        };
        let value = notional(size.0, reserve_price);
        assert!(value >= 1_000_000, "Minimum order notional is 1 USDC");
        let reserved = if reduce_only {
            0
        } else {
            ceil_div(value, leverage as u128) + fee(value) + 100
        };
        let mut order = Order {
            strategy_id,
            id: U64(self.next_order),
            owner: owner.clone(),
            market_id,
            is_long,
            size,
            remaining: size,
            filled_size: U128(0),
            limit_price,
            margin: U128(reserved),
            nonce,
            expiry_ts,
            leverage,
            post_only,
            reduce_only,
            cancelled: false,
            created_at: now() * 1000,
        };
        self.next_order += 1;
        if reduce_only {
            assert!(!post_only, "Reduce-only uses oracle execution");
            let ids = self.trading_account(&owner, strategy_id).positions;
            let mut remaining = size.0;
            for id in ids {
                if remaining == 0 {
                    break;
                }
                let p = self.pairs.get(&id).unwrap();
                if p.market_id != market_id || (p.long == owner) == is_long {
                    continue;
                }
                self.assert_limit(is_long, m.price.0, limit_price.0);
                let amount = remaining.min(p.size.0);
                self.close_pair(id, amount, false);
                remaining -= amount;
            }
            assert!(remaining < size.0, "No opposing position to reduce");
            order.filled_size = U128(size.0 - remaining);
            order.remaining = U128(0);
            order.cancelled = remaining > 0;
            self.save_history(&order);
            return order;
        }
        assert!(a.available.0 >= reserved, "Insufficient free collateral");
        if post_only {
            assert!(
                self.best_cross(&order, &m).is_none(),
                "Post-only order would cross"
            );
        }
        a.available.0 -= reserved;
        a.orders.push(order.id.0);
        self.save_trading_account(strategy_id, &a);
        self.orders.insert(&order.id.0, &order);
        // Bounded automatic price-time matching. Remaining orders can be matched
        // permissionlessly by keepers; no private settlement signing key exists.
        for _ in 0..8 {
            let Some(taker) = self.orders.get(&order.id.0) else {
                break;
            };
            let Some(maker) = self.best_cross(&taker, &m) else {
                break;
            };
            self.execute_match(maker.id.0, taker.id.0);
        }
        if immediate_or_cancel && self.orders.get(&order.id.0).is_some() {
            self.cancel_internal(order.id.0);
        }
        let result = self.orders.get(&order.id.0).unwrap_or_else(|| {
            self.trading_account(&owner, strategy_id)
                .history
                .into_iter()
                .find(|o| o.nonce == nonce)
                .unwrap()
        });
        event("order", near_sdk::serde_json::to_value(&result).unwrap());
        result
    }
}
#[near]
impl Exchange {
    #[payable]
    pub fn match_orders(&mut self, maker_id: U64, taker_id: U64) -> U64 {
        assert_one_yocto();
        assert!(maker_id.0 < taker_id.0, "Maker must precede taker");
        U64(self.execute_match(maker_id.0, taker_id.0))
    }
    #[payable]
    pub fn cancel_order(&mut self, nonce: U64, expiry_ts: Option<U64>) {
        let _ = expiry_ts;
        assert_one_yocto();
        let owner = env::predecessor_account_id();
        let a = self.account(&owner);
        let id = a
            .orders
            .into_iter()
            .find(|id| self.orders.get(id).unwrap().nonce == nonce)
            .expect("Order not open");
        self.cancel_internal(id);
    }
    #[payable]
    pub fn cancel_all(&mut self, market_id: Option<u32>) {
        assert_one_yocto();
        let a = self.account(&env::predecessor_account_id());
        for id in a.orders {
            if market_id.is_none_or(|m| self.orders.get(&id).unwrap().market_id == m) {
                self.cancel_internal(id);
            }
        }
    }
    #[payable]
    pub fn expire_order(&mut self, order_id: U64) {
        assert_one_yocto();
        let o = self.orders.get(&order_id.0).expect("Order not open");
        assert!(o.expiry_ts.0 <= now(), "Order not expired");
        self.cancel_internal(order_id.0);
    }
    #[payable]
    pub fn close_position(
        &mut self,
        position_id: U64,
        amount: Option<U128>,
        min_price: Option<U128>,
        max_price: Option<U128>,
    ) {
        assert_one_yocto();
        let p = self.pairs.get(&position_id.0).expect("Position not open");
        let actor = env::predecessor_account_id();
        assert!((actor == p.long && p.long_strategy_id.is_none()) || (actor == p.short && p.short_strategy_id.is_none()), "Not position owner");
        let m = self.fresh_market(p.market_id);
        assert!(
            min_price.is_none_or(|v| m.price.0 >= v.0)
                && max_price.is_none_or(|v| m.price.0 <= v.0),
            "Close slippage limit"
        );
        self.close_pair(
            position_id.0,
            amount.map(|v| v.0).unwrap_or(p.size.0),
            false,
        );
    }
    #[payable]
    pub fn cancel_strategy_order(&mut self, strategy_id: U64, nonce: U64) {
        assert_one_yocto();
        let s = self.owned_strategy(strategy_id);
        let id = s.orders.into_iter().find(|id| self.orders.get(id).unwrap().nonce == nonce).expect("Order not open");
        self.cancel_internal(id);
    }
    #[payable]
    pub fn close_strategy_position(&mut self, strategy_id: U64, position_id: U64, amount: Option<U128>, min_price: U128, max_price: U128) {
        assert_one_yocto();
        let s = self.owned_strategy(strategy_id);
        let p = self.pairs.get(&position_id.0).expect("Position not open");
        assert!((p.long == s.owner_id && p.long_strategy_id == Some(strategy_id)) || (p.short == s.owner_id && p.short_strategy_id == Some(strategy_id)), "Not strategy position");
        let m = self.fresh_market(p.market_id);
        assert!(min_price.0 <= m.price.0 && m.price.0 <= max_price.0, "Close slippage limit");
        self.close_pair(position_id.0, amount.map(|v| v.0).unwrap_or(p.size.0), false);
    }
    #[payable]
    pub fn liquidate(&mut self, position_id: U64) {
        assert_one_yocto();
        self.account(&env::predecessor_account_id());
        let p = self.pairs.get(&position_id.0).expect("Position not open");
        assert!(
            env::predecessor_account_id() != p.long && env::predecessor_account_id() != p.short,
            "Use close_position for own pair"
        );
        self.close_pair(position_id.0, p.size.0, true);
    }
    #[payable]
    pub fn settle_funding(&mut self, position_id: U64) {
        assert_one_yocto();
        let mut p = self.pairs.get(&position_id.0).expect("Position not open");
        let m = self.fresh_market(p.market_id);
        self.apply_funding(&mut p, &m);
        self.pairs.insert(&p.id.0, &p);
    }
}

impl Exchange {
    fn assert_limit(&self, long: bool, price: u128, limit: u128) {
        assert!(
            if long { price <= limit } else { price >= limit },
            "Limit price violated"
        );
    }
    pub(crate) fn best_cross(&self, taker: &Order, m: &Market) -> Option<Order> {
        if self.trading_account(&taker.owner, taker.strategy_id).positions.len() >= MAX_POSITIONS
            || self.pairs.len() >= MAX_GLOBAL_POSITIONS
        {
            return None;
        }
        self.orders
            .iter()
            .map(|(_, o)| o)
            .filter(|o| {
                o.id != taker.id
                    && self.order_book_active(o) && self.order_book_active(taker)
                    && o.market_id == taker.market_id
                    && o.owner != taker.owner
                    && o.is_long != taker.is_long
                    && o.expiry_ts.0 > now()
                    && o.id.0 < taker.id.0
                    && (if taker.is_long {
                        taker.limit_price.0 >= o.limit_price.0
                    } else {
                        taker.limit_price.0 <= o.limit_price.0
                    })
                    && self.trading_account(&o.owner, o.strategy_id).positions.len() < MAX_POSITIONS
                    && self.match_funded(o, taker, m)
            })
            .min_by(|a, b| {
                let price = if taker.is_long {
                    a.limit_price.0.cmp(&b.limit_price.0)
                } else {
                    b.limit_price.0.cmp(&a.limit_price.0)
                };
                price.then(a.id.0.cmp(&b.id.0))
            })
    }
    fn match_funded(&self, maker: &Order, taker: &Order, m: &Market) -> bool {
        let price = maker.limit_price.0;
        if price < m.price.0 * 95 / 100 || price > m.price.0 * 105 / 100 {
            return false;
        }
        let size = maker.remaining.0.min(taker.remaining.0);
        let value = notional(size, price);
        if value < 1_000_000 {
            return false;
        }
        [maker, taker].iter().all(|o| {
            let share = reserve_share(o, size);
            share >= ceil_div(value, o.leverage as u128) + fee(value)
        })
    }
    fn execute_match(&mut self, maker_id: u64, taker_id: u64) -> u64 {
        let mut maker = self.orders.get(&maker_id).expect("Maker not open");
        let mut taker = self.orders.get(&taker_id).expect("Taker not open");
        let mut m = self.fresh_market(maker.market_id);
        assert!(!self.paused && !m.paused && self.order_book_active(&maker) && self.order_book_active(&taker), "Trading paused");
        assert!(
            maker_id < taker_id
                && maker.market_id == taker.market_id
                && maker.owner != taker.owner
                && maker.is_long != taker.is_long,
            "Invalid match"
        );
        assert!(
            maker.expiry_ts.0 > now() && taker.expiry_ts.0 > now(),
            "Order expired"
        );
        self.assert_limit(taker.is_long, maker.limit_price.0, taker.limit_price.0);
        assert!(
            self.match_funded(&maker, &taker, &m),
            "Match exceeds oracle band or escrow"
        );
        let size = maker.remaining.0.min(taker.remaining.0);
        let price = maker.limit_price;
        assert!(
            m.open_interest.0 + size <= m.max_open_interest.0,
            "OI cap exceeded"
        );
        assert!(
            self.pairs.len() < MAX_GLOBAL_POSITIONS,
            "Global position capacity"
        );
        assert!(
            self.trading_account(&maker.owner, maker.strategy_id).positions.len() < MAX_POSITIONS
                && self.trading_account(&taker.owner, taker.strategy_id).positions.len() < MAX_POSITIONS,
            "Position capacity"
        );
        let value = notional(size, price.0);
        let maker_margin = ceil_div(value, maker.leverage as u128);
        let taker_margin = ceil_div(value, taker.leverage as u128);
        self.consume_order(&mut maker, size, maker_margin, fee(value));
        self.consume_order(&mut taker, size, taker_margin, fee(value));
        let pair = Pair {
            long_strategy_id: if maker.is_long { maker.strategy_id } else { taker.strategy_id },
            short_strategy_id: if maker.is_long { taker.strategy_id } else { maker.strategy_id },
            id: U64(self.next_pair),
            market_id: maker.market_id,
            long: if maker.is_long {
                maker.owner.clone()
            } else {
                taker.owner.clone()
            },
            short: if maker.is_long {
                taker.owner.clone()
            } else {
                maker.owner.clone()
            },
            size: U128(size),
            entry_price: price,
            long_margin: U128(if maker.is_long {
                maker_margin
            } else {
                taker_margin
            }),
            short_margin: U128(if maker.is_long {
                taker_margin
            } else {
                maker_margin
            }),
            last_funding_index: I128(funding_index(&m, now())),
            funding_remainder: I128(0),
        };
        for (owner, book) in [(&maker.owner, maker.strategy_id), (&taker.owner, taker.strategy_id)] {
            let mut a = self.trading_account(owner, book);
            a.positions.push(pair.id.0);
            a.stats.volume.0 += value;
            self.save_trading_account(book, &a);
        }
        self.pairs.insert(&pair.id.0, &pair);
        self.next_pair += 1;
        m.open_interest.0 += size;
        m.last_price = price;
        self.markets.insert(&m.market_id, &m);
        self.record_trade(Trade {
            id: U64(0),
            market_id: m.market_id,
            maker: maker.owner,
            maker_strategy_id: maker.strategy_id, taker_strategy_id: taker.strategy_id,
            taker: taker.owner,
            is_long: taker.is_long,
            price,
            size: U128(size),
            kind: "open".into(),
            maker_pnl: I128(0),
            taker_pnl: I128(0),
            timestamp: now(),
            block_height: U64(env::block_height()),
        });
        pair.id.0
    }
    fn consume_order(&mut self, order: &mut Order, size: u128, margin: u128, fee_amount: u128) {
        let share = reserve_share(order, size);
        let mut a = self.trading_account(&order.owner, order.strategy_id);
        a.available.0 += share - margin - fee_amount;
        a.stats.fees.0 += fee_amount;
        self.insurance += fee_amount;
        order.margin.0 -= share;
        order.remaining.0 -= size;
        order.filled_size.0 += size;
        if order.remaining.0 == 0 {
            self.orders.remove(&order.id.0);
            a.orders.retain(|id| *id != order.id.0);
        } else {
            self.orders.insert(&order.id.0, order);
        }
        self.save_trading_account(order.strategy_id, &a);
        self.save_history(order);
    }
    fn cancel_internal(&mut self, id: u64) {
        let mut o = self.orders.remove(&id).expect("Order not open");
        let mut a = self.trading_account(&o.owner, o.strategy_id);
        a.available.0 += o.margin.0;
        a.orders.retain(|v| *v != id);
        self.save_trading_account(o.strategy_id, &a);
        o.margin = U128(0);
        o.cancelled = true;
        self.save_history(&o);
        event(
            "order_cancelled",
            json!({"owner": o.owner, "strategy_id": o.strategy_id, "nonce": o.nonce, "filled_size": o.filled_size}),
        );
    }
    fn prune_account_orders(&mut self, owner: &AccountId, book: Option<U64>) {
        let a = self.trading_account(owner, book);
        for id in a.orders {
            if self.orders.get(&id).unwrap().expiry_ts.0 <= now() {
                self.cancel_internal(id);
            }
        }
    }
    fn apply_funding(&mut self, p: &mut Pair, m: &Market) {
        let index = funding_index(m, now());
        let (payment, remainder) = funding_settlement(p, index);
        let (long, short) = funded_margins(p, index);
        p.funding_remainder = I128(remainder);
        p.long_margin = U128(long);
        p.short_margin = U128(short);
        p.last_funding_index = I128(index);
        if payment == 0 {
            return;
        }
        let mut a = self.trading_account(&p.long, p.long_strategy_id);
        a.stats.funding.0 -= payment;
        self.save_trading_account(p.long_strategy_id, &a);
        let mut a = self.trading_account(&p.short, p.short_strategy_id);
        a.stats.funding.0 += payment;
        self.save_trading_account(p.short_strategy_id, &a);
        let f = Funding {
            long_strategy_id: p.long_strategy_id, short_strategy_id: p.short_strategy_id,
            id: U64(self.next_funding),
            market_id: p.market_id,
            long: p.long.clone(),
            short: p.short.clone(),
            long_payment: I128(-payment),
            timestamp: now(),
        };
        self.funding.insert(&(self.next_funding % HISTORY_RING), &f);
        self.next_funding += 1;
        event("funding", near_sdk::serde_json::to_value(&f).unwrap());
    }
    fn close_pair(&mut self, id: u64, amount: u128, liquidation: bool) {
        let mut p = self.pairs.get(&id).expect("Position not open");
        assert!(amount > 0 && amount <= p.size.0, "Invalid close size");
        let mut m = self.fresh_market(p.market_id);
        self.apply_funding(&mut p, &m);
        let risk = is_liquidatable(&p, &m);
        if liquidation {
            assert!(risk.0 || risk.1, "Position healthy");
            assert_eq!(amount, p.size.0, "Liquidate entire pair");
        }
        let mut part = p.clone();
        part.size = U128(amount);
        part.long_margin = U128(mul_div(p.long_margin.0, amount, p.size.0));
        part.short_margin = U128(mul_div(p.short_margin.0, amount, p.size.0));
        let (mut long_payout, mut short_payout, pnl) = payout(&part, m.price.0);
        if liquidation {
            let loser = if risk.0 {
                &mut long_payout
            } else {
                &mut short_payout
            };
            let penalty = (*loser).min(mul_div(notional(amount, m.price.0), 50, 10_000));
            *loser -= penalty;
            let reward = penalty / 2;
            self.insurance += penalty - reward;
            let caller = env::predecessor_account_id();
            let mut a = self.account(&caller);
            a.available.0 += reward;
            self.accounts.insert(&caller, &a);
            let loser_id = if risk.0 { &p.long } else { &p.short };
            let book = if risk.0 { p.long_strategy_id } else { p.short_strategy_id };
            let mut a = self.trading_account(loser_id, book);
            a.stats.liquidations += 1;
            a.stats.fees.0 += penalty;
            self.save_trading_account(book, &a);
        }
        for (owner, book, value, realized) in
            [(&p.long, p.long_strategy_id, long_payout, pnl), (&p.short, p.short_strategy_id, short_payout, -pnl)]
        {
            let mut a = self.trading_account(owner, book);
            a.available.0 += value;
            a.stats.realized_pnl.0 += realized;
            a.stats.trades += 1;
            if realized > 0 {
                a.stats.wins += 1;
            }
            a.stats.volume.0 += notional(amount, m.price.0);
            if amount == p.size.0 {
                a.positions.retain(|i| *i != id);
            }
            self.save_trading_account(book, &a);
        }
        if amount == p.size.0 {
            self.pairs.remove(&id);
        } else {
            p.funding_remainder.0 =
                p.funding_remainder.0 * (p.size.0 - amount) as i128 / p.size.0 as i128;
            p.size.0 -= amount;
            p.long_margin.0 -= part.long_margin.0;
            p.short_margin.0 -= part.short_margin.0;
            self.pairs.insert(&id, &p);
        }
        m.open_interest.0 -= amount;
        self.markets.insert(&m.market_id, &m);
        self.record_trade(Trade {
            id: U64(0),
            market_id: m.market_id,
            maker: p.long,
            maker_strategy_id: p.long_strategy_id, taker_strategy_id: p.short_strategy_id,
            taker: p.short,
            is_long: false,
            price: m.price,
            size: U128(amount),
            kind: if liquidation {
                "liquidation".into()
            } else {
                "close".into()
            },
            maker_pnl: I128(pnl),
            taker_pnl: I128(-pnl),
            timestamp: now(),
            block_height: U64(env::block_height()),
        });
    }
}
fn fee(value: u128) -> u128 {
    ceil_div(value * 3, 10_000)
}
fn reserve_share(o: &Order, size: u128) -> u128 {
    if size == o.remaining.0 {
        o.margin.0
    } else {
        mul_div(o.margin.0, size, o.remaining.0)
    }
}
