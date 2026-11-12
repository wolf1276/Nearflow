fn strategy_order(e: &mut Exchange, sid: U64, long: bool, size: u128, nonce: u64) -> Order {
    at("alice.testnet", 1, 100);
    e.place_strategy_order(sid, long, U128(size), U128(100 * PRICE_SCALE), U64(nonce), U64(1000), 10, false, false, false)
}
fn allocated_strategy(e: &mut Exchange) -> U64 {
    let s = strategy(e, "alice.testnet", 50_000_000);
    at("alice.testnet", 1, 100);
    e.allocate_strategy(s.strategy_id, U128(50_000_000));
    s.strategy_id
}
#[test]
fn strategy_orders_partial_match_cancel_and_counterparty_close_conserve() {
    let mut e = setup(); let sid = allocated_strategy(&mut e);
    let manual = e.account(&id("alice.testnet")).available;
    strategy_order(&mut e, sid, true, 2_000_000, 1);
    balanced(&e);
    assert!(e.get_strategy(sid).unwrap().available.0 < 50_000_000);
    order(&mut e, "bob.testnet", false, 1_000_000, 100);
    balanced(&e);
    assert_eq!(e.positions(id("alice.testnet")).len(), 0);
    assert_eq!(e.strategy_positions(sid).len(), 1);
    assert_eq!(e.strategy_orders(sid)[0].filled_size.0, 1_000_000);
    assert_eq!(e.account(&id("alice.testnet")).available, manual);
    at("alice.testnet", 1, 100); e.cancel_strategy_order(sid, U64(1));
    assert_eq!(e.get_strategy(sid).unwrap().available.0, 39_970_000);
    at("bob.testnet", 1, 100); e.close_position(U64(0), Some(U128(400_000)), None, None);
    balanced(&e); assert_eq!(e.strategy_positions(sid)[0].size.0, 600_000);
    e.close_position(U64(0), None, None, None); balanced(&e);
    assert_eq!(e.get_strategy(sid).unwrap().available.0, 49_970_000);
    assert_eq!(e.account(&id("alice.testnet")).available, manual);
}
#[test]
fn strategy_pause_blocks_resting_match_but_allows_cancel_and_fresh_close() {
    let mut e = setup(); let sid = allocated_strategy(&mut e);
    strategy_order(&mut e, sid, true, 1_000_000, 1);
    at("alice.testnet", 1, 100); e.set_strategy_paused(sid, true);
    order(&mut e, "bob.testnet", false, 1_000_000, 100);
    assert!(e.get_pairs().is_empty()); assert!(e.match_candidate(1).is_none());
    assert!(e.orderbook(1).bids.is_empty());
    at("alice.testnet", 1, 100); e.cancel_strategy_order(sid, U64(1)); balanced(&e);
    e.set_strategy_paused(sid, false);
    strategy_order(&mut e, sid, true, 1_000_000, 2);
    at("alice.testnet", 1, 100); e.set_strategy_paused(sid, true);
    e.close_strategy_position(sid, U64(0), None, U128(100 * PRICE_SCALE), U128(100 * PRICE_SCALE));
    balanced(&e); assert!(e.strategy_positions(sid).is_empty());
}
#[test]
#[should_panic(expected = "Not position owner")]
fn manual_close_cannot_close_same_owner_strategy_side() {
    let mut e = setup(); let sid = allocated_strategy(&mut e);
    strategy_order(&mut e, sid, true, 1_000_000, 1);
    order(&mut e, "bob.testnet", false, 1_000_000, 100);
    at("alice.testnet", 1, 100); e.close_position(U64(0), None, None, None);
}
#[test]
#[should_panic(expected = "No opposing position to reduce")]
fn manual_reduce_cannot_consume_strategy_position() {
    let mut e = setup(); let sid = allocated_strategy(&mut e);
    strategy_order(&mut e, sid, true, 1_000_000, 1);
    order(&mut e, "bob.testnet", false, 1_000_000, 100);
    at("alice.testnet", 1, 100);
    e.place_order(1, false, U128(1_000_000), U128(100 * PRICE_SCALE), U64(1), U64(1000), 10, true, false, true);
}
#[test]
#[should_panic(expected = "Not strategy position")]
fn strategy_cannot_close_another_allocation() {
    let mut e = setup(); let a = allocated_strategy(&mut e);
    let b = strategy(&mut e, "alice.testnet", 1);
    strategy_order(&mut e, a, true, 1_000_000, 1);
    order(&mut e, "bob.testnet", false, 1_000_000, 100);
    at("alice.testnet", 1, 100); e.close_strategy_position(b.strategy_id, U64(0), None, U128(0), U128(MAX_PRICE));
}
#[test]
#[should_panic(expected = "Strategy owner only")]
fn forged_strategy_trader_rejected() {
    let mut e = setup(); let sid = allocated_strategy(&mut e);
    at("keeper.testnet", 1, 100);
    e.place_strategy_order(sid, true, U128(1_000_000), U128(100 * PRICE_SCALE), U64(1), U64(1000), 10, false, false, false);
}
#[test]
#[should_panic(expected = "Insufficient strategy collateral")]
fn strategy_escrow_cannot_be_withdrawn() {
    let mut e = setup(); let sid = allocated_strategy(&mut e);
    strategy_order(&mut e, sid, true, 1_000_000, 1);
    at("alice.testnet", 1, 100); let _ = e.withdraw_strategy(sid, U128(50_000_000));
}
#[test]
#[should_panic(expected = "Strategy not accepting allocation")]
fn strategy_cap_counts_escrow_not_only_free_reserve() {
    let mut e = setup(); let sid = allocated_strategy(&mut e);
    strategy_order(&mut e, sid, true, 1_000_000, 1);
    at("alice.testnet", 1, 100); e.allocate_strategy(sid, U128(1));
}
#[test]
fn strategy_funding_and_liquidation_update_only_attributed_book() {
    let mut e = setup(); let sid = allocated_strategy(&mut e);
    strategy_order(&mut e, sid, false, 1_000_000, 1);
    order(&mut e, "bob.testnet", true, 1_000_000, 100);
    let before = e.account(&id("alice.testnet"));
    let mut m = e.market(1); m.funding_rate_ppm = 2000; m.controller.rate_applied_at = 100;
    e.markets.insert(&1, &m);
    at("oracle.testnet", 1, 159); e.publish_price(1, U128(100 * PRICE_SCALE), 159);
    at("keeper.testnet", 1, 159); e.settle_funding(U64(0)); balanced(&e);
    assert!(e.get_strategy(sid).unwrap().stats.funding.0 > 0);
    assert_eq!(e.account(&id("alice.testnet")).stats.funding.0, before.stats.funding.0);
    at("oracle.testnet", 1, 160); e.publish_price(1, U128(120 * PRICE_SCALE), 160);
    at("keeper.testnet", 1, 160); e.liquidate(U64(0)); balanced(&e);
    assert_eq!(e.get_strategy(sid).unwrap().stats.liquidations, 1);
    assert_eq!(e.account(&id("alice.testnet")).stats.liquidations, 0);
    assert_eq!(e.account(&id("alice.testnet")).available, before.available);
}
#[test]
fn strategy_same_owner_books_keep_nonces_and_history_independent() {
    let mut e = setup(); let sid = allocated_strategy(&mut e);
    order(&mut e, "alice.testnet", true, 1_000_000, 100);
    strategy_order(&mut e, sid, true, 1_000_000, 1);
    assert_eq!(e.list_orders(id("alice.testnet")).len(), 1);
    assert_eq!(e.strategy_orders(sid).len(), 1);
    at("alice.testnet", 1, 100); e.cancel_order(U64(1), None);
    assert_eq!(e.get_strategy(sid).unwrap().orders.len(), 1); balanced(&e);
}

#[test]
fn strategy_prepaid_storage_covers_bounded_trading_books() {
    let mut e = setup();
    let before = env::storage_usage();
    let sid = allocated_strategy(&mut e);
    for i in 1..=31 {
        strategy_order(&mut e, sid, true, 10_000, i);
        order(&mut e, "bob.testnet", false, 10_000, 100);
    }
    for i in 32..48 { strategy_order(&mut e, sid, true, 10_000, i); }
    at("alice.testnet", 1, 100); e.cancel_strategy_order(sid, U64(32));
    strategy_order(&mut e, sid, true, 10_000, 48);
    let used = env::storage_usage() - before;
    let prepaid = e.strategy_storage_cost().0 / env::storage_byte_cost().as_yoctonear();
    assert!(used as u128 <= prepaid, "strategy/global trading growth {used} exceeds prepaid {prepaid}");
    assert_eq!(e.get_strategy(sid).unwrap().history.len(), MAX_HISTORY);
    assert_eq!(e.get_strategy(sid).unwrap().positions.len(), 31);
    assert_eq!(e.get_strategy(sid).unwrap().orders.len(), MAX_ORDERS);
    balanced(&e);
}

#[test]
fn strategy_cap_uses_effective_funding_margin_before_lazy_settlement() {
    let mut e = setup(); let sid = allocated_strategy(&mut e);
    strategy_order(&mut e, sid, false, 1_000_000, 1);
    order(&mut e, "bob.testnet", true, 1_000_000, 100);
    let mut m = e.market(1); m.funding_rate_ppm = 2000; m.controller.rate_applied_at = 100;
    e.markets.insert(&1, &m);
    // The opening fee leaves 30,000 of cap room, then funding consumes it.
    at("oracle.testnet", 1, 159); e.publish_price(1, U128(100 * PRICE_SCALE), 159);
    at("oracle.testnet", 1, 218); e.publish_price(1, U128(100 * PRICE_SCALE), 218);
    at("oracle.testnet", 1, 277); e.publish_price(1, U128(100 * PRICE_SCALE), 277);
    at("oracle.testnet", 1, 336); e.publish_price(1, U128(100 * PRICE_SCALE), 336);
    at("oracle.testnet", 1, 395); e.publish_price(1, U128(100 * PRICE_SCALE), 395);
    at("oracle.testnet", 1, 454); e.publish_price(1, U128(100 * PRICE_SCALE), 454);
    at("oracle.testnet", 1, 513); e.publish_price(1, U128(100 * PRICE_SCALE), 513);
    at("oracle.testnet", 1, 572); e.publish_price(1, U128(100 * PRICE_SCALE), 572);
    at("oracle.testnet", 1, 631); e.publish_price(1, U128(100 * PRICE_SCALE), 631);
    at("oracle.testnet", 1, 690); e.publish_price(1, U128(100 * PRICE_SCALE), 690);
    let account = e.strategy_accounting(sid);
    assert!(account["effective_total"].as_str().unwrap().parse::<u128>().unwrap() > 50_000_000);
    assert_eq!(e.pairs.get(&0).unwrap().short_margin.0, 10_000_000);
    at("usdc.testnet", 0, 690);
    assert!(matches!(e.ft_on_transfer(id("alice.testnet"), U128(1), "strategy:0".into()), PromiseOrValue::Value(U128(1))));
    balanced(&e);
}
#[test]
fn strategy_audit_rejects_duplicate_attribution_even_when_custody_sum_matches() {
    let mut e = setup(); let sid = allocated_strategy(&mut e);
    strategy_order(&mut e, sid, true, 1_000_000, 1);
    let mut s = e.get_strategy(sid).unwrap(); s.orders.push(s.orders[0]); e.strategies.insert(&sid.0, &s);
    assert_eq!(e.audit()["balanced"], false);
}
