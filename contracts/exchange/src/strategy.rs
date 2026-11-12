//! Real NEP-141 custody allocated within the existing exchange ledger.
//! Owner-signed trading uses isolated books; no delegation or spot adapter.
use crate::*;

const MAX_STRATEGIES: u64 = 128;
const MAX_OWNER_STRATEGIES: usize = 8;
const MAX_PENDING: u32 = 4;
const STORAGE_BYTES: u128 = 32_768;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Strategy {
    pub strategy_id: U64,
    pub owner_id: AccountId,
    pub market_id: u32,
    pub collateral_cap: U128,
    pub available: U128,
    pub last_nonce: U64,
    pub orders: Vec<u64>,
    pub positions: Vec<u64>,
    pub history: Vec<Order>,
    pub stats: Stats,
    pub pending_withdrawals: U128,
    pub pending_count: u32,
    pub paused: bool,
    pub closed: bool,
    pub created_at: u64,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct StrategyWithdrawal {
    pub withdrawal_id: U64,
    pub strategy_id: U64,
    pub owner_id: AccountId,
    pub amount: U128,
}

#[near]
impl Exchange {
    pub fn strategy_storage_cost(&self) -> U128 {
        U128(env::storage_byte_cost().as_yoctonear() * STORAGE_BYTES)
    }

    /// Owner registration must precede creation. Storage stays prepaid for the
    /// tombstone and up to four in-flight withdrawals; no unregistration/refund.
    #[payable]
    pub fn create_strategy(&mut self, market_id: u32, collateral_cap: U128) -> Strategy {
        assert!(!self.paused, "Trading paused");
        let owner = env::predecessor_account_id();
        self.account(&owner);
        self.market(market_id);
        assert!(
            collateral_cap.0 > 0 && collateral_cap.0 <= self.cap,
            "Invalid strategy cap"
        );
        assert!(self.strategies.len() < MAX_STRATEGIES, "Strategy capacity");
        assert!(
            self.strategies
                .iter()
                .filter(|(_, s)| s.owner_id == owner)
                .count()
                < MAX_OWNER_STRATEGIES,
            "Owner strategy capacity"
        );
        let cost = self.strategy_storage_cost().0;
        let attached = env::attached_deposit().as_yoctonear();
        assert!(attached >= cost, "Insufficient strategy storage deposit");
        let s = Strategy {
            strategy_id: U64(self.next_strategy),
            owner_id: owner.clone(),
            market_id,
            collateral_cap,
            available: U128(0),
            last_nonce: U64(0),
            orders: vec![],
            positions: vec![],
            history: vec![],
            stats: Stats::default(),
            pending_withdrawals: U128(0),
            pending_count: 0,
            paused: false,
            closed: false,
            created_at: now(),
        };
        self.next_strategy = self
            .next_strategy
            .checked_add(1)
            .expect("Strategy ID overflow");
        self.strategies.insert(&s.strategy_id.0, &s);
        if attached > cost {
            Promise::new(owner)
                .transfer(NearToken::from_yoctonear(attached - cost))
                .detach();
        }
        event(
            "strategy_created",
            json!({"strategy": s, "execution": "OWNER_SIGNED_PERP", "storage_paid": U128(cost)}),
        );
        s
    }

    pub fn get_strategy(&self, strategy_id: U64) -> Option<Strategy> {
        self.strategies.get(&strategy_id.0)
    }
    pub fn get_strategies(
        &self,
        owner_id: AccountId,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<Strategy> {
        self.strategies
            .iter()
            .map(|(_, s)| s)
            .filter(|s| s.owner_id == owner_id)
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(8).min(8) as usize)
            .collect()
    }
    pub fn strategy_accounting(&self, strategy_id: U64) -> near_sdk::serde_json::Value {
        let s = self.strategies.get(&strategy_id.0).expect("Unknown strategy");
        let escrow: u128 = s.orders.iter().map(|id| self.orders.get(id).unwrap().margin.0).sum();
        let stored: u128 = s.positions.iter().map(|id| {
            let p = self.pairs.get(id).unwrap();
            if p.long_strategy_id == Some(strategy_id) { p.long_margin.0 } else { p.short_margin.0 }
        }).sum();
        let funded: u128 = self.strategy_positions(strategy_id).iter().map(|p| p.margin.0).sum();
        json!({"strategy_id": strategy_id, "available": s.available, "order_escrow": U128(escrow),
            "stored_margin": U128(stored), "funded_margin": U128(funded), "pending": s.pending_withdrawals,
            "stored_total": U128(s.available.0 + escrow + stored + s.pending_withdrawals.0),
            "effective_total": U128(s.available.0 + escrow + funded + s.pending_withdrawals.0),
            "unrealized_pnl_withdrawable": false})
    }
    pub fn get_strategy_withdrawal(&self, withdrawal_id: U64) -> Option<StrategyWithdrawal> {
        self.strategy_withdrawals.get(&withdrawal_id.0)
    }

    /// Moves only this owner's free exchange collateral. Never duplicates custody.
    #[payable]
    pub fn allocate_strategy(&mut self, strategy_id: U64, amount: U128) {
        assert_one_yocto();
        let mut s = self.owned_strategy(strategy_id);
        assert!(
            self.strategy_accepts(&s, amount.0),
            "Strategy not accepting allocation"
        );
        let mut a = self.account(&s.owner_id);
        a.available.0 = a
            .available
            .0
            .checked_sub(amount.0)
            .expect("Insufficient free collateral");
        s.available.0 += amount.0;
        self.accounts.insert(&s.owner_id, &a);
        self.strategies.insert(&strategy_id.0, &s);
        event(
            "strategy_allocated",
            json!({"strategy_id": strategy_id, "amount": amount, "source": "exchange"}),
        );
    }

    /// Owner release to their exchange balance, not an external payout.
    #[payable]
    pub fn release_strategy(&mut self, strategy_id: U64, amount: U128) {
        assert_one_yocto();
        let mut s = self.owned_strategy(strategy_id);
        assert!(amount.0 > 0, "Zero release");
        s.available.0 = s
            .available
            .0
            .checked_sub(amount.0)
            .expect("Insufficient strategy collateral");
        let mut a = self.account(&s.owner_id);
        a.available.0 += amount.0;
        self.accounts.insert(&s.owner_id, &a);
        self.strategies.insert(&strategy_id.0, &s);
        event(
            "strategy_released",
            json!({"strategy_id": strategy_id, "amount": amount}),
        );
    }

    #[payable]
    pub fn set_strategy_paused(&mut self, strategy_id: U64, paused: bool) {
        assert_one_yocto();
        let mut s = self.owned_strategy(strategy_id);
        assert!(!s.closed, "Strategy closed");
        s.paused = paused;
        self.strategies.insert(&strategy_id.0, &s);
        event(
            "strategy_paused",
            json!({"strategy_id": strategy_id, "paused": paused}),
        );
    }

    /// Terminal, empty custody record. No deletion/ID reuse while receipts exist.
    #[payable]
    pub fn close_strategy(&mut self, strategy_id: U64) {
        assert_one_yocto();
        let mut s = self.owned_strategy(strategy_id);
        assert!(!s.closed, "Strategy closed");
        assert!(
            s.available.0 == 0 && s.pending_withdrawals.0 == 0 && s.pending_count == 0
                && s.orders.is_empty() && s.positions.is_empty(),
            "Strategy not settled and empty"
        );
        s.closed = true;
        s.paused = true;
        self.strategies.insert(&strategy_id.0, &s);
        event("strategy_closed", json!({"strategy_id": strategy_id}));
    }

    /// Fixed recipient = recorded owner. No guardian/admin withdrawal authority.
    #[payable]
    pub fn withdraw_strategy(&mut self, strategy_id: U64, amount: U128) -> Promise {
        assert_one_yocto();
        assert!(
            env::prepaid_gas() >= Gas::from_tgas(80),
            "Insufficient withdrawal gas"
        );
        let mut s = self.owned_strategy(strategy_id);
        assert!(amount.0 > 0, "Zero withdrawal");
        assert!(
            s.pending_count < MAX_PENDING,
            "Pending strategy withdrawal limit"
        );
        s.available.0 = s
            .available
            .0
            .checked_sub(amount.0)
            .expect("Insufficient strategy collateral");
        s.pending_withdrawals.0 += amount.0;
        s.pending_count += 1;
        let request = StrategyWithdrawal {
            withdrawal_id: U64(self.next_strategy_withdrawal),
            strategy_id,
            owner_id: s.owner_id.clone(),
            amount,
        };
        self.next_strategy_withdrawal = self
            .next_strategy_withdrawal
            .checked_add(1)
            .expect("Withdrawal ID overflow");
        self.pending_withdrawals += amount.0;
        self.strategies.insert(&strategy_id.0, &s);
        self.strategy_withdrawals
            .insert(&request.withdrawal_id.0, &request);
        event("strategy_withdrawal_requested", json!({"request": request}));
        ft::ext(self.token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(30))
            .ft_transfer(
                s.owner_id,
                amount,
                Some("Reflex Perps strategy withdrawal".into()),
            )
            .then(
                callback::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .resolve_strategy_withdraw(request.withdrawal_id),
            )
    }

    #[private]
    pub fn resolve_strategy_withdraw(&mut self, withdrawal_id: U64) -> bool {
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
        let request = self
            .strategy_withdrawals
            .remove(&withdrawal_id.0)
            .expect("Unknown or resolved strategy withdrawal");
        let mut s = self
            .strategies
            .get(&request.strategy_id.0)
            .expect("Unknown strategy");
        assert_eq!(s.owner_id, request.owner_id, "Withdrawal owner mismatch");
        s.pending_withdrawals.0 = s
            .pending_withdrawals
            .0
            .checked_sub(request.amount.0)
            .expect("Pending underflow");
        s.pending_count = s
            .pending_count
            .checked_sub(1)
            .expect("Pending count underflow");
        self.pending_withdrawals -= request.amount.0;
        let success = env::promise_result_checked(0, 1024).is_ok();
        if success {
            self.total -= request.amount.0;
            let mut a = self.account(&s.owner_id);
            a.stats.withdrawn.0 += request.amount.0;
            self.accounts.insert(&s.owner_id, &a);
        } else {
            s.available.0 += request.amount.0;
        }
        self.strategies.insert(&request.strategy_id.0, &s);
        event(
            "strategy_withdrawal_resolved",
            json!({"request": request, "success": success}),
        );
        success
    }
}

impl Exchange {
    // Account-shaped working copy; only save_trading_account persists the selected book.
    pub(crate) fn trading_account(&self, owner: &AccountId, strategy_id: Option<U64>) -> Account {
        match strategy_id {
            None => self.account(owner),
            Some(id) => {
                let s = self.strategies.get(&id.0).expect("Unknown strategy");
                assert_eq!(&s.owner_id, owner, "Strategy owner mismatch");
                Account { account_id: owner.clone(), available: s.available, last_nonce: s.last_nonce,
                    orders: s.orders, positions: s.positions, history: s.history, stats: s.stats }
            }
        }
    }
    pub(crate) fn save_trading_account(&mut self, strategy_id: Option<U64>, a: &Account) {
        match strategy_id {
            None => { self.accounts.insert(&a.account_id, a); }
            Some(id) => {
                let mut s = self.strategies.get(&id.0).expect("Unknown strategy");
                assert_eq!(s.owner_id, a.account_id, "Strategy owner mismatch");
                s.available = a.available;
                s.last_nonce = a.last_nonce;
                s.orders = a.orders.clone();
                s.positions = a.positions.clone();
                s.history = a.history.clone();
                s.stats = a.stats.clone();
                self.strategies.insert(&id.0, &s);
            }
        }
    }
    pub(crate) fn strategy_committed(&self, s: &Strategy) -> u128 {
        let orders: u128 = s.orders.iter().map(|id| self.orders.get(id).expect("Missing strategy order").margin.0).sum();
        let positions: u128 = s.positions.iter().map(|id| {
            let p = self.pairs.get(id).expect("Missing strategy position");
            let m = self.market(p.market_id);
            let (long, short) = funded_margins(&p, funding_index(&m, now()));
            if p.long_strategy_id == Some(s.strategy_id) { long } else {
                assert_eq!(p.short_strategy_id, Some(s.strategy_id), "Strategy position mismatch");
                short
            }
        }).sum();
        s.available.0 + orders + positions
    }
    pub(crate) fn order_book_active(&self, o: &Order) -> bool {
        o.strategy_id.is_none_or(|id| {
            self.strategies.get(&id.0).is_some_and(|s|
                s.owner_id == o.owner && s.market_id == o.market_id && !s.paused && !s.closed)
        })
    }
    pub(crate) fn owned_strategy(&self, strategy_id: U64) -> Strategy {
        let s = self
            .strategies
            .get(&strategy_id.0)
            .expect("Unknown strategy");
        assert_eq!(
            env::predecessor_account_id(),
            s.owner_id,
            "Strategy owner only"
        );
        s
    }
    fn strategy_accepts(&self, s: &Strategy, amount: u128) -> bool {
        !self.paused
            && !s.paused
            && !s.closed
            && amount > 0
            && self.strategy_committed(s)
                .checked_add(s.pending_withdrawals.0)
                .and_then(|n| n.checked_add(amount))
                .is_some_and(|n| n <= s.collateral_cap.0)
    }
    /// Only called after immutable token predecessor verification in ft_on_transfer.
    pub(crate) fn strategy_on_transfer(
        &mut self,
        sender: AccountId,
        amount: U128,
        msg: &str,
    ) -> PromiseOrValue<U128> {
        let unused = PromiseOrValue::Value(amount);
        if msg.len() > 32 {
            return unused;
        }
        let raw = &msg["strategy:".len()..];
        let Ok(id) = raw.parse::<u64>() else {
            return unused;
        };
        if raw != id.to_string() {
            return unused;
        }
        let Some(mut s) = self.strategies.get(&id) else {
            return unused;
        };
        if sender != s.owner_id || !self.strategy_accepts(&s, amount.0) {
            return unused;
        }
        let Some(total) = self.total.checked_add(amount.0).filter(|t| *t <= self.cap) else {
            return unused;
        };
        let mut a = self.account(&sender);
        s.available.0 += amount.0;
        a.stats.deposited.0 += amount.0;
        self.strategies.insert(&id, &s);
        self.accounts.insert(&sender, &a);
        self.total = total;
        event(
            "strategy_allocated",
            json!({"strategy_id": U64(id), "amount": amount, "source": "token"}),
        );
        PromiseOrValue::Value(U128(0))
    }
}
