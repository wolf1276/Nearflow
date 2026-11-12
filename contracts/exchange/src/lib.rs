//! NEARFlow testnet isolated, collateral-capped bilateral perpetuals.
//! Custody, order authorization, matching and settlement share ONE atomic state.
mod controller;
mod math;
mod model;
#[cfg(test)]
mod rounding_tests;
mod strategy;
#[cfg(test)]
mod tests;
mod trading;
mod views;

use math::*;
use model::*;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, assert_one_yocto,
    collections::UnorderedMap,
    env, ext_contract,
    json_types::{I128, U64, U128},
    near,
    serde_json::json,
};

#[ext_contract(ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}
#[ext_contract(callback)]
#[allow(dead_code)]
trait Callbacks {
    fn resolve_withdraw(&mut self, account_id: AccountId, amount: U128) -> bool;
    fn resolve_strategy_withdraw(&mut self, withdrawal_id: U64) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Exchange {
    token_id: AccountId,
    owner_id: AccountId,
    oracle_id: AccountId,
    accounts: UnorderedMap<AccountId, Account>,
    markets: UnorderedMap<u32, Market>,
    orders: UnorderedMap<u64, Order>,
    pairs: UnorderedMap<u64, Pair>,
    trades: UnorderedMap<u64, Trade>,
    funding: UnorderedMap<u64, Funding>,
    strategies: UnorderedMap<u64, strategy::Strategy>,
    strategy_withdrawals: UnorderedMap<u64, strategy::StrategyWithdrawal>,
    next_strategy: u64,
    next_strategy_withdrawal: u64,
    next_order: u64,
    next_pair: u64,
    next_trade: u64,
    next_funding: u64,
    total: u128,
    cap: u128,
    insurance: u128,
    pending_withdrawals: u128,
    registration_cost: u128,
    paused: bool,
}

#[near]
impl Exchange {
    #[init]
    pub fn new(token_id: AccountId, oracle_id: AccountId, deposit_cap: U128) -> Self {
        assert!(
            env::current_account_id().as_str().ends_with(".testnet"),
            "Testnet only"
        );
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Initialize with contract account"
        );
        assert!(
            deposit_cap.0 > 0 && deposit_cap.0 <= 10_000_000_000,
            "Cap must be <= 10,000 test USDC"
        );
        Self {
            token_id,
            oracle_id,
            owner_id: env::predecessor_account_id(),
            accounts: UnorderedMap::new(b"a"),
            markets: UnorderedMap::new(b"m"),
            orders: UnorderedMap::new(b"o"),
            pairs: UnorderedMap::new(b"p"),
            trades: UnorderedMap::new(b"t"),
            funding: UnorderedMap::new(b"f"),
            strategies: UnorderedMap::new(b"s"),
            strategy_withdrawals: UnorderedMap::new(b"w"),
            next_strategy: 0,
            next_strategy_withdrawal: 0,
            next_order: 0,
            next_pair: 0,
            next_trade: 0,
            next_funding: 0,
            total: 0,
            cap: deposit_cap.0,
            insurance: 0,
            pending_withdrawals: 0,
            // Bounded per-account order/position/history vectors, including map overhead.
            registration_cost: env::storage_byte_cost().as_yoctonear() * 32_768,
            paused: false,
        }
    }

    #[payable]
    pub fn add_market(
        &mut self,
        market_id: u32,
        symbol: String,
        initial_margin_bps: u32,
        maintenance_margin_bps: u32,
        max_open_interest: U128,
    ) {
        self.assert_owner();
        assert_one_yocto();
        assert!(
            self.markets.len() < 8 && self.markets.get(&market_id).is_none(),
            "Market exists or limit reached"
        );
        assert!(
            market_id > 0
                && symbol.len() <= 12
                && symbol
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
            "Invalid symbol"
        );
        assert!(
            initial_margin_bps >= 1000 && initial_margin_bps <= 10_000,
            "Max leverage is 10x on testnet"
        );
        assert!(
            maintenance_margin_bps >= 100 && maintenance_margin_bps < initial_margin_bps,
            "Invalid maintenance margin"
        );
        assert!(
            max_open_interest.0 > 0 && max_open_interest.0 <= 1_000_000_000_000_000,
            "Invalid OI cap"
        );
        self.markets.insert(
            &market_id,
            &Market {
                market_id,
                symbol,
                initial_margin_bps,
                maintenance_margin_bps,
                max_open_interest,
                price: U128(0),
                timestamp: 0,
                last_price: U128(0),
                funding_index: I128(0),
                funding_rate_bps: 0,
                funding_rate_ppm: 0,
                controller: FundingController::default(),
                funding_updated_at: 0,
                open_interest: U128(0),
                paused: false,
            },
        );
    }
    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        assert_one_yocto();
        self.paused = paused;
    }
    #[payable]
    pub fn set_market_paused(&mut self, market_id: u32, paused: bool) {
        self.assert_owner();
        assert_one_yocto();
        let mut m = self.market(market_id);
        m.paused = paused;
        self.markets.insert(&market_id, &m);
    }
    #[payable]
    pub fn set_oracle(&mut self, oracle_id: AccountId) {
        self.assert_owner();
        assert_one_yocto();
        self.oracle_id = oracle_id;
    }

    /// Prices are USD scaled 1e18. Trusted publisher only; never supplied by traders.
    #[payable]
    pub fn publish_price(&mut self, market_id: u32, price: U128, timestamp: u64) {
        assert_one_yocto();
        assert_eq!(env::predecessor_account_id(), self.oracle_id, "Oracle only");
        let now = now();
        assert!(
            timestamp <= now && now - timestamp <= 10,
            "Invalid oracle timestamp"
        );
        assert!(price.0 > 0 && price.0 <= MAX_PRICE, "Invalid price");
        let mut m = self.market(market_id);
        assert!(timestamp > m.timestamp, "Oracle timestamp must advance");
        m.funding_index = I128(funding_index(&m, now));
        m.funding_updated_at = now;
        m.price = price;
        m.timestamp = timestamp;
        // Publishing an index never advances the hourly controller or its EMA.
        self.markets.insert(&market_id, &m);
        event(
            "oracle_price",
            json!({"market_id": market_id, "price": price, "timestamp": timestamp}),
        );
    }

    pub fn storage_balance_bounds(&self) -> StorageBounds {
        StorageBounds {
            min: U128(self.registration_cost),
            max: Some(U128(self.registration_cost)),
        }
    }
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.accounts.get(&account_id).map(|_| StorageBalance {
            total: U128(self.registration_cost),
            available: U128(0),
        })
    }
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only;
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        let attached = env::attached_deposit().as_yoctonear();
        let refund = if self.accounts.get(&account_id).is_some() {
            attached
        } else {
            assert!(self.accounts.len() < 1000, "Testnet account limit");
            assert!(
                attached >= self.registration_cost,
                "Insufficient storage deposit"
            );
            self.accounts.insert(
                &account_id,
                &Account {
                    account_id: account_id.clone(),
                    available: U128(0),
                    last_nonce: U64(0),
                    orders: vec![],
                    positions: vec![],
                    history: vec![],
                    stats: Stats::default(),
                },
            );
            attached - self.registration_cost
        };
        if refund > 0 {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
        self.storage_balance_of(account_id).unwrap()
    }
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_eq!(
            env::predecessor_account_id(),
            self.token_id,
            "Untrusted token"
        );
        if msg.starts_with("strategy:") {
            return self.strategy_on_transfer(sender_id, amount, &msg);
        }
        if amount.0 == 0 || (msg != "" && msg != "insurance") {
            return PromiseOrValue::Value(amount);
        }
        let Some(total) = self.total.checked_add(amount.0).filter(|t| *t <= self.cap) else {
            return PromiseOrValue::Value(amount);
        };
        if msg == "insurance" {
            self.insurance += amount.0;
        } else {
            let Some(mut a) = self.accounts.get(&sender_id) else {
                return PromiseOrValue::Value(amount);
            };
            a.available.0 += amount.0;
            a.stats.deposited.0 += amount.0;
            self.accounts.insert(&sender_id, &a);
        }
        self.total = total;
        event(
            "deposit",
            json!({"account_id": sender_id, "amount": amount, "insurance": msg == "insurance"}),
        );
        PromiseOrValue::Value(U128(0))
    }
    pub fn balance_of(&self, account_id: AccountId, token_id: AccountId) -> U128 {
        self.assert_token(&token_id);
        self.accounts
            .get(&account_id)
            .map(|a| a.available)
            .unwrap_or(U128(0))
    }
    pub fn collateral(&self, token_id: AccountId) -> Option<Collateral> {
        (token_id == self.token_id).then_some(Collateral {
            oracle_symbol: "USDC".into(),
            haircut_bps: 0,
            active: true,
        })
    }
    pub fn deposit_cap(&self, token_id: AccountId) -> Option<U128> {
        self.assert_token(&token_id);
        Some(U128(self.cap))
    }
    pub fn total_deposited(&self, token_id: AccountId) -> U128 {
        self.assert_token(&token_id);
        U128(self.total)
    }
    #[payable]
    pub fn withdraw(&mut self, token_id: AccountId, amount: U128) -> Promise {
        assert_one_yocto();
        self.assert_token(&token_id);
        assert!(amount.0 > 0, "Zero withdrawal");
        assert!(
            env::prepaid_gas() >= Gas::from_tgas(70),
            "Insufficient withdrawal gas"
        );
        let account_id = env::predecessor_account_id();
        let mut a = self.account(&account_id);
        // Only unlocked collateral can leave. Orders and positions hold separate escrow.
        a.available.0 = a
            .available
            .0
            .checked_sub(amount.0)
            .expect("Insufficient free collateral");
        self.accounts.insert(&account_id, &a);
        self.pending_withdrawals += amount.0;
        ft::ext(self.token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(30))
            .ft_transfer(
                account_id.clone(),
                amount,
                Some("NEARFlow withdrawal".into()),
            )
            .then(
                callback::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .resolve_withdraw(account_id, amount),
            )
    }
    #[private]
    pub fn resolve_withdraw(&mut self, account_id: AccountId, amount: U128) -> bool {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Callback only"
        );
        assert_eq!(
            env::promise_results_count(),
            1,
            "Expected one transfer result"
        );
        let mut a = self.account(&account_id);
        self.pending_withdrawals -= amount.0;
        // NEP-141 ft_transfer returns unit; do not load unbounded receipt data.
        let success = env::promise_result_checked(0, 1024).is_ok();
        if success {
            self.total -= amount.0;
            a.stats.withdrawn.0 += amount.0;
        } else {
            a.available.0 += amount.0;
        }
        self.accounts.insert(&account_id, &a);
        event(
            "withdrawal",
            json!({"account_id": account_id, "amount": amount, "success": success}),
        );
        success
    }
}
impl Exchange {
    fn assert_owner(&self) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Owner only");
    }
    fn assert_token(&self, token: &AccountId) {
        assert_eq!(token, &self.token_id, "Unknown collateral");
    }
    fn account(&self, id: &AccountId) -> Account {
        self.accounts.get(id).expect("Register storage first")
    }
    fn market(&self, id: u32) -> Market {
        self.markets.get(&id).expect("Unknown market")
    }
    fn fresh_market(&self, id: u32) -> Market {
        let m = self.market(id);
        assert!(oracle_fresh(&m, now()), "Oracle stale");
        m
    }
    fn recent_market_trade(&self, market_id: u32) -> Option<Trade> {
        (self.next_trade.saturating_sub(HISTORY_RING)..self.next_trade)
            .rev()
            .filter_map(|id| self.trades.get(&(id % HISTORY_RING)))
            .find(|t| t.market_id == market_id && t.kind == "open")
    }
    fn save_history(&mut self, order: &Order) {
        let mut a = self.trading_account(&order.owner, order.strategy_id);
        a.history.retain(|o| o.nonce != order.nonce);
        a.history.push(order.clone());
        if a.history.len() > MAX_HISTORY {
            a.history.remove(0);
        }
        self.save_trading_account(order.strategy_id, &a);
    }
    fn record_trade(&mut self, mut trade: Trade) {
        trade.id = U64(self.next_trade);
        self.trades
            .insert(&(self.next_trade % HISTORY_RING), &trade);
        self.next_trade += 1;
        event("trade", near_sdk::serde_json::to_value(&trade).unwrap());
    }
}
fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}
fn event(name: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard":"nearflow", "version":"1.0.0", "event":name, "data":[data]})
    ));
}
