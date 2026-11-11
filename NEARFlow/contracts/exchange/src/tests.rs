use super::*;
use near_sdk::{PromiseResult, test_utils::VMContextBuilder, testing_env};
fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn ctx(caller: &str, deposit: u128, time: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("desk.testnet"))
        .predecessor_account_id(id(caller))
        .signer_account_id(id(caller))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(time * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    b
}
fn at(caller: &str, deposit: u128, time: u64) {
    testing_env!(ctx(caller, deposit, time).build());
}
fn setup() -> Exchange {
    at("desk.testnet", 0, 100);
    let mut e = Exchange::new(
        id("usdc.testnet"),
        id("oracle.testnet"),
        U128(1_000_000_000),
    );
    at("desk.testnet", 1, 100);
    e.add_market(1, "NEAR".into(), 1000, 500, U128(1_000_000_000));
    for user in ["alice.testnet", "bob.testnet", "keeper.testnet"] {
        at(user, e.registration_cost, 100);
        e.storage_deposit(None, Some(true));
        deposit(&mut e, user, 100_000_000);
    }
    price(&mut e, 100, 100);
    e
}
fn deposit(e: &mut Exchange, user: &str, amount: u128) {
    at("usdc.testnet", 0, 100);
    assert!(matches!(
        e.ft_on_transfer(id(user), U128(amount), String::new()),
        PromiseOrValue::Value(U128(0))
    ));
}
fn price(e: &mut Exchange, dollars: u128, time: u64) {
    at("oracle.testnet", 1, time);
    e.publish_price(1, U128(dollars * PRICE_SCALE), time);
}
fn order(e: &mut Exchange, user: &str, long: bool, size: u128, price: u128) -> Order {
    let nonce = e.next_nonce(id(user));
    at(user, 1, 100);
    e.place_order(
        1,
        long,
        U128(size),
        U128(price * PRICE_SCALE),
        nonce,
        U64(1000),
        10,
        false,
        false,
        false,
    )
}
fn matched() -> Exchange {
    let mut e = setup();
    order(&mut e, "alice.testnet", true, 1_000_000, 100);
    order(&mut e, "bob.testnet", false, 1_000_000, 100);
    e
}
fn balanced(e: &Exchange) {
    assert_eq!(e.audit()["balanced"], true);
}
#[test]
fn matched_orders_lock_margin_atomically() {
    let e = matched();
    assert_eq!(e.orders.len(), 0);
    assert_eq!(e.pairs.len(), 1);
    let p = e.pairs.get(&0).unwrap();
    assert_eq!(p.long_margin.0, 10_000_000);
    assert_eq!(p.short_margin.0, 10_000_000);
    assert_eq!(e.insurance, 60_000);
    assert_eq!(e.positions(id("alice.testnet"))[0].margin.0, 10_000_000);
    assert_eq!(e.market(1).open_interest.0, 1_000_000);
    balanced(&e);
}
#[test]
fn cancel_unlocks_only_own_order() {
    let mut e = setup();
    let before = e.account(&id("alice.testnet")).available.0;
    let o = order(&mut e, "alice.testnet", true, 1_000_000, 100);
    assert!(e.account(&id("alice.testnet")).available.0 < before);
    at("alice.testnet", 1, 100);
    e.cancel_order(o.nonce, None);
    assert_eq!(e.account(&id("alice.testnet")).available.0, before);
    balanced(&e);
}
#[test]
#[should_panic(expected = "Order not open")]
fn cannot_cancel_another_account() {
    let mut e = setup();
    let o = order(&mut e, "alice.testnet", true, 1_000_000, 100);
    at("bob.testnet", 1, 100);
    e.cancel_order(o.nonce, None);
}
#[test]
#[should_panic(expected = "Nonce already used")]
fn nonce_replay_rejected_after_cancel() {
    let mut e = setup();
    let o = order(&mut e, "alice.testnet", true, 1_000_000, 100);
    at("alice.testnet", 1, 100);
    e.cancel_order(o.nonce, None);
    e.place_order(
        1,
        true,
        U128(1_000_000),
        U128(100 * PRICE_SCALE),
        o.nonce,
        U64(1000),
        10,
        false,
        false,
        false,
    );
}
#[test]
fn partial_fill_retains_remaining_escrow() {
    let mut e = setup();
    order(&mut e, "alice.testnet", true, 2_000_000, 100);
    order(&mut e, "bob.testnet", false, 1_000_000, 100);
    assert_eq!(e.orders.get(&0).unwrap().remaining.0, 1_000_000);
    assert_eq!(e.pairs.len(), 1);
    balanced(&e);
}
#[test]
fn self_trade_never_matches() {
    let mut e = setup();
    order(&mut e, "alice.testnet", true, 1_000_000, 100);
    order(&mut e, "alice.testnet", false, 1_000_000, 100);
    assert_eq!(e.pairs.len(), 0);
    assert_eq!(e.orders.len(), 2);
    balanced(&e);
}
#[test]
fn closes_both_sides_and_realizes_equal_opposite_pnl() {
    let mut e = matched();
    price(&mut e, 104, 101);
    at("alice.testnet", 1, 101);
    e.close_position(U64(0), None, None, None);
    assert_eq!(e.pairs.len(), 0);
    assert_eq!(e.market(1).open_interest.0, 0);
    assert_eq!(
        e.account(&id("alice.testnet")).stats.realized_pnl.0,
        4_000_000
    );
    assert_eq!(
        e.account(&id("bob.testnet")).stats.realized_pnl.0,
        -4_000_000
    );
    balanced(&e);
}
#[test]
fn gap_loss_is_capped_to_pair_margin_without_debt() {
    let mut e = matched();
    price(&mut e, 1000, 101);
    at("alice.testnet", 1, 101);
    e.close_position(U64(0), None, None, None);
    assert_eq!(
        e.account(&id("alice.testnet")).stats.realized_pnl.0,
        10_000_000
    );
    assert_eq!(
        e.account(&id("bob.testnet")).stats.realized_pnl.0,
        -10_000_000
    );
    balanced(&e);
}
#[test]
fn partial_close_is_conservative() {
    let mut e = matched();
    price(&mut e, 103, 101);
    at("alice.testnet", 1, 101);
    e.close_position(U64(0), Some(U128(400_000)), None, None);
    assert_eq!(e.pairs.get(&0).unwrap().size.0, 600_000);
    assert_eq!(e.pairs.get(&0).unwrap().long_margin.0, 6_000_000);
    balanced(&e);
    e.close_position(U64(0), None, None, None);
    balanced(&e);
}
#[test]
fn liquidation_pays_reward_without_touching_other_accounts() {
    let mut e = matched();
    price(&mut e, 106, 101);
    let before = e.account(&id("keeper.testnet")).available.0;
    at("keeper.testnet", 1, 101);
    e.liquidate(U64(0));
    assert_eq!(e.pairs.len(), 0);
    assert!(e.account(&id("keeper.testnet")).available.0 > before);
    assert_eq!(e.account(&id("bob.testnet")).stats.liquidations, 1);
    balanced(&e);
}
#[test]
#[should_panic(expected = "Position healthy")]
fn healthy_position_cannot_be_liquidated() {
    let mut e = matched();
    at("keeper.testnet", 1, 100);
    e.liquidate(U64(0));
}
#[test]
#[should_panic(expected = "Oracle stale")]
fn stale_oracle_blocks_new_orders() {
    let mut e = setup();
    at("alice.testnet", 1, 161);
    e.place_order(
        1,
        true,
        U128(1_000_000),
        U128(100 * PRICE_SCALE),
        U64(1),
        U64(1000),
        10,
        false,
        false,
        false,
    );
}
#[test]
#[should_panic(expected = "Oracle only")]
fn traders_cannot_publish_prices() {
    let mut e = setup();
    at("alice.testnet", 1, 101);
    e.publish_price(1, U128(PRICE_SCALE), 101);
}
#[test]
#[should_panic(expected = "Oracle timestamp must advance")]
fn oracle_replay_rejected() {
    let mut e = setup();
    price(&mut e, 100, 100);
}
#[test]
#[should_panic(expected = "Invalid oracle timestamp")]
fn future_oracle_rejected() {
    let mut e = setup();
    at("oracle.testnet", 1, 100);
    e.publish_price(1, U128(PRICE_SCALE), 101);
}
#[test]
fn funding_is_zero_sum_and_cannot_be_replayed() {
    let mut e = matched();
    let mut m = e.market(1);
    m.funding_rate_bps = 10;
    e.markets.insert(&1, &m);
    at("keeper.testnet", 1, 120);
    e.settle_funding(U64(0));
    let p = e.pairs.get(&0).unwrap();
    assert!(p.long_margin.0 < 10_000_000);
    assert_eq!(p.long_margin.0 + p.short_margin.0, 20_000_000);
    e.settle_funding(U64(0));
    assert_eq!(p.long_margin.0, e.pairs.get(&0).unwrap().long_margin.0);
    balanced(&e);
}
#[test]
fn funding_stops_when_oracle_expires() {
    let mut e = matched();
    let mut m = e.market(1);
    m.funding_rate_bps = 10;
    e.markets.insert(&1, &m);
    assert_eq!(funding_index(&m, 160), funding_index(&m, 5000));
}
#[test]
fn reduce_only_cannot_increase_position() {
    let mut e = matched();
    at("alice.testnet", 1, 100);
    e.place_order(
        1,
        false,
        U128(500_000),
        U128(99 * PRICE_SCALE),
        U64(2),
        U64(1000),
        10,
        true,
        false,
        true,
    );
    assert_eq!(e.pairs.get(&0).unwrap().size.0, 500_000);
    assert_eq!(e.orders.len(), 0);
    balanced(&e);
}
#[test]
fn ioc_cancels_unmatched_remainder() {
    let mut e = setup();
    at("alice.testnet", 1, 100);
    let o = e.place_order(
        1,
        true,
        U128(1_000_000),
        U128(100 * PRICE_SCALE),
        U64(1),
        U64(1000),
        10,
        false,
        false,
        true,
    );
    assert!(o.cancelled);
    assert_eq!(e.orders.len(), 0);
    assert_eq!(e.account(&id("alice.testnet")).available.0, 100_000_000);
    balanced(&e);
}
#[test]
#[should_panic(expected = "Post-only order would cross")]
fn post_only_rejects_crossing() {
    let mut e = setup();
    order(&mut e, "alice.testnet", true, 1_000_000, 100);
    at("bob.testnet", 1, 100);
    e.place_order(
        1,
        false,
        U128(1_000_000),
        U128(100 * PRICE_SCALE),
        U64(1),
        U64(1000),
        10,
        false,
        true,
        false,
    );
}
#[test]
fn paused_venue_allows_exit_and_cancel() {
    let mut e = matched();
    at("desk.testnet", 1, 100);
    e.set_paused(true);
    at("alice.testnet", 1, 100);
    e.close_position(U64(0), None, None, None);
    balanced(&e);
}
#[test]
#[should_panic(expected = "Trading paused")]
fn paused_venue_blocks_new_exposure() {
    let mut e = setup();
    at("desk.testnet", 1, 100);
    e.set_paused(true);
    order(&mut e, "alice.testnet", true, 1_000_000, 100);
}
#[test]
#[should_panic(expected = "Insufficient free collateral")]
fn locked_margin_cannot_be_withdrawn() {
    let mut e = matched();
    at("alice.testnet", 1, 100);
    let _ = e.withdraw(id("usdc.testnet"), U128(100_000_000));
}
#[test]
fn failed_withdrawal_restores_reservation() {
    let mut e = matched();
    at("alice.testnet", 1, 100);
    let before = e.account(&id("alice.testnet")).available.0;
    let _ = e.withdraw(id("usdc.testnet"), U128(5_000_000));
    balanced(&e);
    testing_env!(
        ctx("desk.testnet", 0, 100).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    assert!(!e.resolve_withdraw(id("alice.testnet"), U128(5_000_000)));
    assert_eq!(e.account(&id("alice.testnet")).available.0, before);
    balanced(&e);
}
#[test]
fn successful_withdrawal_reduces_custody_and_liability() {
    let mut e = matched();
    at("alice.testnet", 1, 100);
    let _ = e.withdraw(id("usdc.testnet"), U128(5_000_000));
    testing_env!(
        ctx("desk.testnet", 0, 100).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![])]
    );
    assert!(e.resolve_withdraw(id("alice.testnet"), U128(5_000_000)));
    assert_eq!(e.total, 295_000_000);
    balanced(&e);
}
#[test]
#[should_panic(expected = "Untrusted token")]
fn spoofed_token_rejected() {
    let mut e = setup();
    at("alice.testnet", 0, 100);
    let _ = e.ft_on_transfer(id("alice.testnet"), U128(1), String::new());
}
#[test]
fn unregistered_sender_refunded() {
    let mut e = setup();
    at("usdc.testnet", 0, 100);
    assert!(matches!(
        e.ft_on_transfer(id("stranger.testnet"), U128(1), String::new()),
        PromiseOrValue::Value(U128(1))
    ));
    balanced(&e);
}
#[test]
fn deposit_cap_refunds_entire_transfer() {
    let mut e = setup();
    at("usdc.testnet", 0, 100);
    assert!(matches!(
        e.ft_on_transfer(id("alice.testnet"), U128(1_000_000_000), String::new()),
        PromiseOrValue::Value(U128(1_000_000_000))
    ));
    balanced(&e);
}
#[test]
fn price_time_priority() {
    let mut e = setup();
    order(&mut e, "alice.testnet", false, 1_000_000, 101);
    order(&mut e, "keeper.testnet", false, 1_000_000, 100);
    order(&mut e, "bob.testnet", true, 1_000_000, 102);
    assert_eq!(e.pairs.get(&0).unwrap().short, id("keeper.testnet"));
    balanced(&e);
}
#[test]
fn wide_math_does_not_overflow_intermediate() {
    assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
}
#[test]
fn repeated_fills_and_exits_preserve_custody() {
    let mut e = setup();
    for _ in 0..20 {
        order(&mut e, "alice.testnet", true, 1_000_000, 100);
        order(&mut e, "bob.testnet", false, 1_000_000, 100);
        let pair_id = e.next_pair - 1;
        at("alice.testnet", 1, 100);
        e.close_position(U64(pair_id), None, None, None);
        balanced(&e);
    }
    assert_eq!(e.pairs.len(), 0);
    assert!(e.account(&id("alice.testnet")).history.len() <= MAX_HISTORY);
}
#[test]
#[should_panic(expected = "Callback only")]
fn external_caller_cannot_forge_withdrawal_callback() {
    let mut e = setup();
    at("alice.testnet", 0, 100);
    e.resolve_withdraw(id("alice.testnet"), U128(10_000_000));
}
#[test]
#[should_panic(expected = "Not position owner")]
fn non_owner_cannot_force_healthy_close() {
    let mut e = matched();
    at("keeper.testnet", 1, 100);
    e.close_position(U64(0), None, None, None);
}
#[test]
#[should_panic(expected = "Leverage exceeds market cap")]
fn leverage_cap_is_enforced_on_chain() {
    let mut e = setup();
    at("alice.testnet", 1, 100);
    e.place_order(
        1,
        true,
        U128(1_000_000),
        U128(100 * PRICE_SCALE),
        U64(1),
        U64(1000),
        50,
        false,
        false,
        false,
    );
}
#[test]
fn expiry_cleanup_unlocks_collateral_without_oracle() {
    let mut e = setup();
    let o = order(&mut e, "alice.testnet", true, 1_000_000, 100);
    at("keeper.testnet", 1, 1001);
    e.expire_order(o.id);
    assert_eq!(e.account(&id("alice.testnet")).available.0, 100_000_000);
    balanced(&e);
}
#[test]
#[should_panic(expected = "OI cap exceeded")]
fn open_interest_cap_is_enforced() {
    let mut e = setup();
    let mut m = e.market(1);
    m.max_open_interest = U128(500_000);
    e.markets.insert(&1, &m);
    order(&mut e, "alice.testnet", true, 1_000_000, 100);
    order(&mut e, "bob.testnet", false, 1_000_000, 100);
}
#[test]
fn oracle_outage_cannot_block_free_collateral_exit() {
    let mut e = matched();
    at("alice.testnet", 1, 1000);
    let _ = e.withdraw(id("usdc.testnet"), U128(5_000_000));
    balanced(&e);
}
#[test]
#[should_panic(expected = "Close slippage limit")]
fn close_price_protection_is_on_chain() {
    let mut e = matched();
    at("alice.testnet", 1, 100);
    e.close_position(U64(0), None, Some(U128(101 * PRICE_SCALE)), None);
}
#[test]
fn funding_is_bounded_by_the_payers_margin() {
    let mut e = matched();
    let mut p = e.pairs.get(&0).unwrap();
    p.long_margin = U128(1);
    p.short_margin = U128(19_999_999);
    let payment = funding_payment(&p, 1000 * PRICE_SCALE as i128);
    assert_eq!(payment, 1);
    let (long, short) = funded_margins(&p, 1000 * PRICE_SCALE as i128);
    assert_eq!(long + short, 20_000_000);
    e.pairs.insert(&0, &p);
    balanced(&e);
}
