fn funding_trade(e: &mut Exchange, mark: u128, time: u64) {
    e.record_trade(Trade { maker_strategy_id: None, taker_strategy_id: None, id: U64(0), market_id: 1, maker: id("alice.testnet"),
        taker: id("bob.testnet"), is_long: true, price: U128(mark * PRICE_SCALE),
        size: U128(1_000_000), kind: "open".into(), maker_pnl: I128(0), taker_pnl: I128(0),
        timestamp: time, block_height: U64(1) });
}
fn update(e: &mut Exchange, time: u64) {
    at("keeper.testnet", 1, time);
    e.update_funding(1, U64(time / 3600));
}
#[test]
fn controller_accrues_old_index_before_rate_and_price_changes() {
    let mut e = matched();
    funding_trade(&mut e, 101, 100);
    update(&mut e, 100);
    assert_eq!(e.market(1).funding_rate_ppm, 2000);
    let before = funding_index(&e.market(1), 120);
    price(&mut e, 99, 120);
    assert_eq!(e.market(1).funding_index.0, before);
    assert_eq!(e.market(1).funding_rate_ppm, 2000); // oracle ticks don't step controller
    at("desk.testnet", 1, 130);
    let expected = funding_index(&e.market(1), 130);
    e.configure_funding(1, nearflow_funding::Mode::Adaptive, Default::default(), 1);
    assert_eq!(e.market(1).funding_index.0, expected);
    assert_eq!(e.market(1).funding_rate_ppm, 0);
    assert_eq!(e.market(1).controller.last_epoch, Some(0));
    // Lazy settlement sees the history even though the new rate is zero.
    at("keeper.testnet", 1, 130);
    e.settle_funding(U64(0));
    let paid = e.pairs.get(&0).unwrap();
    assert!(paid.long_margin.0 < 10_000_000);
    assert_eq!(paid.long_margin.0 + paid.short_margin.0, 20_000_000);
    e.settle_funding(U64(0));
    assert_eq!(paid.long_margin.0, e.pairs.get(&0).unwrap().long_margin.0);
    balanced(&e);
}
#[test]
fn controller_updates_once_hourly_and_resets_ema_on_mark_fallback() {
    let mut e = matched();
    at("desk.testnet", 1, 100);
    e.configure_funding(1, nearflow_funding::Mode::Adaptive, Default::default(), 1);
    price(&mut e, 100, 3600);
    funding_trade(&mut e, 101, 3600);
    update(&mut e, 3600);
    assert_eq!(e.market(1).funding_rate_ppm, 400);
    assert_eq!(e.market(1).controller.premium_ema_ppm, Some(10000));
    price(&mut e, 100, 7200);
    funding_trade(&mut e, 99, 7200);
    update(&mut e, 7200);
    assert_eq!(e.market(1).controller.premium_ema_ppm, Some(0));
    assert_eq!(e.market(1).funding_rate_ppm, 320);
    price(&mut e, 100, 10800);
    update(&mut e, 10800); // recent fill now stale
    assert!(e.market(1).controller.fallback);
    assert_eq!(e.market(1).funding_rate_ppm, 0);
    assert_eq!(e.market(1).controller.premium_ema_ppm, None);
    balanced(&e);
}
#[test]
fn missing_and_divergent_marks_fall_back_without_invented_prices() {
    let mut e = setup();
    update(&mut e, 100);
    assert!(e.market(1).controller.fallback);
    price(&mut e, 100, 3600);
    funding_trade(&mut e, 1000, 3600);
    update(&mut e, 3600);
    assert!(e.market(1).controller.fallback);
    assert_eq!(e.market(1).funding_rate_ppm, 0);
}
#[test]
fn funding_rate_expires_even_if_oracle_keeps_publishing() {
    let mut e = matched();
    funding_trade(&mut e, 101, 100);
    update(&mut e, 100);
    for t in (120..=3760).step_by(20) { price(&mut e, 100, t); }
    let m = e.market(1);
    assert_eq!(m.funding_index.0, funding_index(&m, 10000));
    let ideal = (100 * PRICE_SCALE * 2000 / 1_000_000) as i128;
    // Each price checkpoint truncates <1 index unit (1e-18 USD/base).
    assert!((0..180).contains(&(ideal - m.funding_index.0)));
    // Skipped epochs don't earn historical funding when the keeper resumes.
    price(&mut e, 100, 18000);
    funding_trade(&mut e, 99, 18000);
    update(&mut e, 18000);
    assert_eq!(e.market(1).funding_index.0, m.funding_index.0);
    // EMA is observation-based: previous +10,000 and new -10,000 average to zero.
    assert_eq!(e.market(1).funding_rate_ppm, 0);
    assert_eq!(e.market(1).controller.last_epoch, Some(5));
}
#[test]
#[should_panic(expected = "Funding epoch already applied")]
fn funding_epoch_replay_rejected() {
    let mut e = matched(); update(&mut e, 100); update(&mut e, 101);
}
#[test]
#[should_panic(expected = "Expected current funding epoch")]
fn old_or_future_epoch_rejected() {
    let mut e = matched(); at("keeper.testnet", 1, 100); e.update_funding(1, U64(1));
}
#[test]
#[should_panic(expected = "Funding epoch already applied")]
fn configuration_cannot_bypass_cadence() {
    let mut e = matched(); update(&mut e, 100);
    at("desk.testnet", 1, 110);
    e.configure_funding(1, nearflow_funding::Mode::Adaptive, Default::default(), 1);
    update(&mut e, 110);
}
#[test]
#[should_panic(expected = "Owner only")]
fn funding_mode_is_owner_restricted() {
    let mut e = matched(); at("alice.testnet", 1, 100);
    e.configure_funding(1, nearflow_funding::Mode::Adaptive, Default::default(), 1);
}
#[test]
#[should_panic(expected = "Configuration revision mismatch")]
fn configuration_revision_replay_rejected() {
    let mut e = matched(); at("desk.testnet", 1, 100);
    e.configure_funding(1, nearflow_funding::Mode::Adaptive, Default::default(), 0);
}
#[test]
#[should_panic(expected = "Invalid funding parameters")]
fn unsafe_configuration_rejected() {
    let mut e = matched(); at("desk.testnet", 1, 100);
    let mut params = nearflow_funding::Params::default(); params.cap_ppm = i64::MAX;
    e.configure_funding(1, nearflow_funding::Mode::Adaptive, params, 1);
}
#[test]
#[should_panic(expected = "Oracle stale")]
fn stale_oracle_cannot_apply_funding() {
    let mut e = matched(); update(&mut e, 161);
}
#[test]
fn funding_snapshot_uses_one_chain_time_without_mutating_stored_history() {
    let mut e = matched();
    funding_trade(&mut e, 101, 100);
    update(&mut e, 100);
    at("keeper.testnet", 1, 110);
    let stored = e.market(1).funding_index;
    let snapshot = e.funding_snapshot();
    assert_eq!(snapshot["timestamp"], 110);
    assert_eq!(snapshot["status"]["token_id"], "usdc.testnet");
    let market = snapshot["markets"].as_array().unwrap().iter()
        .find(|m| m["market_id"] == 1).unwrap();
    assert_eq!(market["funding_index"], funding_index(&e.market(1), 110).to_string());
    assert_eq!(market["controller"]["rate_applied_at"], 100);
    assert_eq!(e.market(1).funding_index, stored);
}
#[test]
fn configured_freshness_boundaries_agree_with_risk_views() {
    let mut e = matched();
    let mut m = e.market(1);
    m.controller.params.oracle_max_age_sec = 10;
    m.price = U128(PRICE_SCALE); // make the long liquidatable
    e.markets.insert(&1, &m);
    for (time, fresh) in [(100, true), (110, true), (111, false), (99, false)] {
        at("keeper.testnet", 1, time);
        assert_eq!(oracle_fresh(&m, time), fresh);
        assert_eq!(e.account_health(id("alice.testnet"), id("usdc.testnet")).oracle_stale, !fresh);
        assert_eq!(!e.liquidatable_pairs().is_empty(), fresh);
        if fresh { assert_eq!(e.fresh_market(1).timestamp, 100); }
    }
}
#[test]
fn match_proposals_use_configured_ttl_and_reject_future_prices() {
    let mut e = setup();
    order(&mut e, "alice.testnet", true, 1_000_000, 100);
    order(&mut e, "bob.testnet", false, 1_000_000, 101);
    let mut m = e.market(1);
    m.controller.params.oracle_max_age_sec = 10;
    e.markets.insert(&1, &m);
    // Make the resting orders cross without executing a new order.
    let key = e.orders.iter().find(|(_, o)| !o.is_long).unwrap().0;
    let mut ask = e.orders.get(&key).unwrap();
    ask.limit_price = U128(100 * PRICE_SCALE);
    e.orders.insert(&key, &ask);
    for (time, fresh) in [(110, true), (111, false), (99, false)] {
        at("keeper.testnet", 1, time);
        assert_eq!(e.match_candidate(1).is_some(), fresh);
    }
}
#[test]
#[should_panic(expected = "Oracle stale")]
fn configured_short_ttl_blocks_execution() {
    let mut e = matched();
    let mut m = e.market(1);
    m.controller.params.oracle_max_age_sec = 10;
    e.markets.insert(&1, &m);
    update(&mut e, 111);
}
#[test]
#[should_panic(expected = "Oracle stale")]
fn future_oracle_blocks_execution() {
    let e = matched();
    at("keeper.testnet", 1, 99);
    e.fresh_market(1);
}
#[test]
fn funding_index_expiry_boundaries_and_future_inputs() {
    let mut e = matched();
    funding_trade(&mut e, 101, 100);
    update(&mut e, 100);
    let mut m = e.market(1);
    m.controller.params.oracle_max_age_sec = 10;
    assert!(funding_index(&m, 109) < funding_index(&m, 110));
    assert_eq!(funding_index(&m, 110), funding_index(&m, 111));
    assert_eq!(funding_index(&m, 99), m.funding_index.0);
    m.timestamp = 3695;
    assert!(oracle_fresh(&m, 3700));
    assert!(funding_index(&m, 3699) < funding_index(&m, 3700));
    assert_eq!(funding_index(&m, 3700), funding_index(&m, 3701));
}
#[test]
fn future_and_evicted_marks_zero_the_rate() {
    let mut e = setup();
    funding_trade(&mut e, 101, 101);
    update(&mut e, 100);
    assert!(e.market(1).controller.fallback);
    price(&mut e, 100, 3600);
    for _ in 0..HISTORY_RING {
        at("keeper.testnet", 1, 3600); // each fill is a separate receipt
        let mut trade = e.trades.get(&0).unwrap();
        trade.market_id = 2;
        e.record_trade(trade);
    }
    assert!(e.recent_market_trade(1).is_none());
    update(&mut e, 3600);
    assert!(e.market(1).controller.fallback);
    assert_eq!(e.market(1).funding_rate_ppm, 0);
}
