#[test]
fn seeded_config_rate_settlement_and_partial_close_sequences_conserve() {
    let mut e = setup();
    let mut seed = 0x46345f7265666c65u64;
    let mut random = || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1); seed.rotate_right(23) };
    let mut time = 100;
    for cycle in 0..32 {
        time += 3600;
        price(&mut e, 100, time);
        let size = 100_000 + random() as u128 % 400_000;
        for (owner, long) in [("alice.testnet", true), ("bob.testnet", false)] {
            at(owner, 1, time);
            e.place_order(1, long, U128(size), U128(100 * PRICE_SCALE), e.next_nonce(id(owner)),
                U64(time + 86400), 10, false, false, false);
        }
        let pair_id = e.next_pair - 1;
        let mut params = nearflow_funding::Params::default();
        params.cap_ppm = if random() & 1 == 0 { 1 } else { 2000 };
        params.step_ppm = if random() & 2 == 0 { 1 } else { params.cap_ppm };
        params.smoothing_ppm = if random() & 4 == 0 { 1 } else { 1_000_000 };
        params.ema_alpha_ppm = if random() & 8 == 0 { 1 } else { 1_000_000 };
        params.deadband_ppm = if random() & 16 == 0 { 0 } else { 1999 };
        params.nonlinear_scale_ppm = if random() & 32 == 0 { 1000 } else { 100_000 };
        params.oracle_max_age_sec = if random() & 64 == 0 { 1 } else { 60 };
        params.mark_max_age_sec = if random() & 128 == 0 { 1 } else { 300 };
        let mode = if cycle % 2 == 0 { nearflow_funding::Mode::Baseline } else { nearflow_funding::Mode::Adaptive };
        let old = e.market(1);
        let checkpoint = e.pairs.get(&pair_id).unwrap().last_funding_index;
        at("desk.testnet", 1, time);
        e.configure_funding(1, mode, params.clone(), old.controller.revision);
        assert_eq!(e.market(1).funding_index.0, funding_index(&old, time));
        assert_eq!(e.pairs.get(&pair_id).unwrap().last_funding_index, checkpoint);
        for step in 0..4 {
            time += 3600;
            let previous = e.market(1);
            price(&mut e, 98 + random() as u128 % 5, time);
            assert_eq!(e.market(1).funding_index.0, funding_index(&previous, time));
            let mut trade_price = e.market(1).price.0;
            let sign = if (cycle + step) % 2 == 0 { 1i128 } else { -1 };
            trade_price = (trade_price as i128 * (1_000_000 + sign * params.max_premium_ppm as i128) / 1_000_000) as u128;
            at("keeper.testnet", 1, time);
            e.record_trade(Trade { maker_strategy_id: None, taker_strategy_id: None, id: U64(0), market_id: 1, maker: id("alice.testnet"), taker: id("bob.testnet"),
                is_long: true, price: U128(trade_price), size: U128(size), kind: "open".into(),
                maker_pnl: I128(0), taker_pnl: I128(0), timestamp: time, block_height: U64(1) });
            update(&mut e, time);
            let applied = e.market(1);
            assert!(applied.funding_rate_ppm.abs() <= params.cap_ppm);
            time += params.oracle_max_age_sec; // exact execution-valid freshness boundary
            let before = e.pairs.get(&pair_id).unwrap();
            let index = funding_index(&applied, time);
            let numerator = before.size.0 as i128 * (index - before.last_funding_index.0) + before.funding_remainder.0;
            let owed = numerator / PRICE_SCALE as i128;
            let payment = owed.clamp(-(before.short_margin.0 as i128), before.long_margin.0 as i128);
            at("keeper.testnet", 1, time);
            e.settle_funding(U64(pair_id));
            let funded = e.pairs.get(&pair_id).unwrap();
            assert_eq!(funded.long_margin.0 as i128, before.long_margin.0 as i128 - payment);
            assert_eq!(funded.short_margin.0 as i128, before.short_margin.0 as i128 + payment);
            assert_eq!(funded.funding_remainder.0, if owed == payment { numerator % PRICE_SCALE as i128 } else { 0 });
            let serialized = near_sdk::borsh::to_vec(&funded).unwrap();
            at("keeper.testnet", 1, time);
            e.settle_funding(U64(pair_id));
            assert_eq!(near_sdk::borsh::to_vec(&e.pairs.get(&pair_id).unwrap()).unwrap(), serialized);
            let amount = if step == 3 { funded.size.0 } else { (funded.size.0 / (2 + random() as u128 % 3)).max(1) };
            at("alice.testnet", 1, time);
            e.close_position(U64(pair_id), Some(U128(amount)), None, None);
            if step < 3 {
                let remaining = e.pairs.get(&pair_id).unwrap();
                assert_eq!(remaining.size.0, funded.size.0 - amount);
                assert_eq!(remaining.long_margin.0, funded.long_margin.0 - funded.long_margin.0 * amount / funded.size.0);
                assert_eq!(remaining.short_margin.0, funded.short_margin.0 - funded.short_margin.0 * amount / funded.size.0);
                assert_eq!(remaining.funding_remainder.0, funded.funding_remainder.0 * remaining.size.0 as i128 / funded.size.0 as i128);
            } else { assert!(e.pairs.get(&pair_id).is_none()); }
            balanced(&e);
            assert_eq!(e.account(&id("alice.testnet")).stats.funding.0 + e.account(&id("bob.testnet")).stats.funding.0, 0);
        }
    }
}
#[test]
fn accepted_parameter_corners_preserve_caps_and_signed_symmetry() {
    use nearflow_funding::{Params, Mode, ema, rate};
    for bits in 0..512 {
        let mut p = Params::default();
        p.cap_ppm = if bits & 1 == 0 { 1 } else { 2000 };
        p.step_ppm = if bits & 2 == 0 { 1 } else { p.cap_ppm };
        p.smoothing_ppm = if bits & 4 == 0 { 1 } else { 1_000_000 };
        p.ema_alpha_ppm = if bits & 8 == 0 { 1 } else { 1_000_000 };
        p.max_premium_ppm = if bits & 16 == 0 { 2000 } else { 100_000 };
        p.deadband_ppm = if bits & 32 == 0 { 0 } else { 2000.min(p.max_premium_ppm - 1) };
        p.nonlinear_scale_ppm = if bits & 64 == 0 { 1000 } else { 100_000 };
        p.oracle_max_age_sec = if bits & 128 == 0 { 1 } else { 60 };
        p.mark_max_age_sec = if bits & 256 == 0 { 1 } else { 300 };
        p.validate().unwrap();
        for sample in [-p.max_premium_ppm, -1, 0, 1, p.max_premium_ppm] {
            let smoothed = ema(sample, Some(-sample), &p).unwrap();
            assert!(smoothed.abs() <= p.max_premium_ppm);
            assert_eq!(smoothed, -ema(-sample, Some(sample), &p).unwrap());
            for previous in [-p.cap_ppm, 0, p.cap_ppm] {
                for mode in [Mode::Baseline, Mode::Adaptive] {
                    let next = rate(mode, smoothed, previous, &p).unwrap();
                    assert!(next.abs() <= p.cap_ppm);
                    if mode == Mode::Adaptive { assert!((next - previous).abs() <= p.step_ppm); }
                    assert_eq!(next, -rate(mode, -smoothed, -previous, &p).unwrap());
                }
            }
        }
    }
}
#[test]
fn pre_controller_market_bytes_are_incompatible_with_current_storage() {
    use near_sdk::borsh::BorshDeserialize;
    let e = setup();
    let m = e.market(1);
    // Exact pre-controller Market field order at source revision 01cc71a.
    let legacy = near_sdk::borsh::to_vec(&(m.market_id, m.symbol.clone(), m.initial_margin_bps,
        m.maintenance_margin_bps, m.max_open_interest, m.price, m.timestamp, m.last_price,
        m.funding_index, m.funding_rate_bps, m.funding_updated_at, m.open_interest, m.paused)).unwrap();
    assert!(Market::try_from_slice(&legacy).is_err());
    let current = near_sdk::borsh::to_vec(&m).unwrap();
    let restored = Market::try_from_slice(&current).unwrap();
    assert_eq!(near_sdk::serde_json::to_value(restored).unwrap(), near_sdk::serde_json::to_value(m).unwrap());
}
#[test]
fn root_exchange_state_rejects_legacy_layout_and_preserves_funded_roundtrip() {
    use near_sdk::borsh::BorshDeserialize;
    let e = matched();
    // Exact root field order before strategy maps/counters, revision 01cc71a.
    let legacy = near_sdk::borsh::to_vec(&(&e.token_id, &e.owner_id, &e.oracle_id,
        &e.accounts, &e.markets, &e.orders, &e.pairs, &e.trades, &e.funding,
        e.next_order, e.next_pair, e.next_trade, e.next_funding, e.total, e.cap,
        e.insurance, e.pending_withdrawals, e.registration_cost, e.paused)).unwrap();
    assert!(Exchange::try_from_slice(&legacy).is_err());
    let current = near_sdk::borsh::to_vec(&e).unwrap();
    let restored = Exchange::try_from_slice(&current).unwrap();
    assert_eq!(restored.audit(), e.audit());
    assert_eq!(restored.total, 300_000_000);
    assert_eq!(restored.pairs.len(), 1);
    assert_eq!(near_sdk::borsh::to_vec(&restored).unwrap(), current);
}
#[test]
fn funding_and_payout_at_price_size_and_collateral_extremes() {
    let e = matched();
    for price in [1u128, PRICE_SCALE, MAX_PRICE] {
        for size in [1u128, 1_000_000_000_000_000] {
            for margin in [0u128, 1, 5_000_000_000] {
                for rate in [-2000i64, -1, 0, 1, 2000] {
                    let mut m = e.market(1);
                    m.price = U128(price); m.funding_rate_ppm = rate;
                    m.funding_index = I128(0); m.funding_updated_at = 100;
                    m.timestamp = 100; m.controller.rate_applied_at = 100;
                    let expected_abs = price * rate.unsigned_abs() as u128 * 60 / (1_000_000 * 3600);
                    let expected_index = if rate < 0 { -(expected_abs as i128) } else { expected_abs as i128 };
                    let index = funding_index(&m, 160);
                    assert_eq!(index, expected_index);
                    assert_eq!(funding_index(&m, u64::MAX), index);
                    let mut p = e.pairs.get(&0).unwrap();
                    p.size = U128(size); p.entry_price = U128(price);
                    p.long_margin = U128(margin); p.short_margin = U128(margin);
                    p.last_funding_index = I128(0); p.funding_remainder = I128(0);
                    // Independent quotient/remainder split avoids a size*index u128 overflow.
                    let whole = (expected_abs / PRICE_SCALE) * size + (expected_abs % PRICE_SCALE) * size / PRICE_SCALE;
                    let signed = if rate < 0 { -(whole as i128) } else { whole as i128 };
                    let expected_payment = signed.clamp(-(margin as i128), margin as i128);
                    assert_eq!(funding_payment(&p, index), expected_payment);
                    let (long, short) = funded_margins(&p, index);
                    assert_eq!(long + short, margin * 2);
                    p.long_margin = U128(long); p.short_margin = U128(short);
                    for exit in [1u128, MAX_PRICE] {
                        let value = payout(&p, exit);
                        assert_eq!(value.0 + value.1, margin * 2);
                        assert!(value.2 >= -(long as i128) && value.2 <= short as i128);
                    }
                }
            }
        }
    }
}
#[test]
#[should_panic(expected = "Insufficient free collateral")]
fn numerically_allowed_max_price_size_cannot_bypass_custody() {
    let mut e = setup();
    at("oracle.testnet", 1, 101);
    e.publish_price(1, U128(MAX_PRICE), 101);
    at("alice.testnet", 1, 101);
    e.place_order(1, true, U128(1_000_000_000_000_000), U128(MAX_PRICE), U64(1), U64(1000), 10, false, false, false);
}
#[test]
#[should_panic(expected = "Minimum order notional")]
fn numerically_allowed_min_price_size_still_requires_minimum_notional() {
    let mut e = setup();
    at("oracle.testnet", 1, 101);
    e.publish_price(1, U128(1), 101);
    at("alice.testnet", 1, 101);
    e.place_order(1, true, U128(1), U128(1), U64(1), U64(1000), 10, false, false, false);
}
#[test]
fn signed_index_checkpoint_truncation_is_bounded() {
    let e = matched();
    for sign in [-1i64, 1] {
        let mut m = e.market(1);
        m.price = U128(100 * PRICE_SCALE + 1);
        m.funding_rate_ppm = sign * 2000;
        m.controller.rate_applied_at = 100;
        let uninterrupted = funding_index(&m, 160);
        for time in 101..=160 {
            m.funding_index = I128(funding_index(&m, time));
            m.funding_updated_at = time;
        }
        let lost = (uninterrupted - m.funding_index.0) * sign as i128;
        assert!((0..60).contains(&lost));
        assert_eq!(funding_index(&m, 161), m.funding_index.0);
    }
}
#[test]
fn partial_close_discards_only_closed_fraction_of_subatom_funding_dust() {
    let mut e = setup();
    for sign in [-1i128, 1] {
        order(&mut e, "alice.testnet", true, 1_000_000, 100);
        order(&mut e, "bob.testnet", false, 1_000_000, 100);
        let pair_id = e.next_pair - 1;
        let mut p = e.pairs.get(&pair_id).unwrap();
        p.funding_remainder = I128(sign * (PRICE_SCALE as i128 - 1));
        e.pairs.insert(&pair_id, &p);
        let amount = p.size.0 / 3;
        at("alice.testnet", 1, 100);
        e.close_position(U64(pair_id), Some(U128(amount)), None, None);
        let remaining = e.pairs.get(&pair_id).unwrap();
        let expected = p.funding_remainder.0 * (p.size.0 - amount) as i128 / p.size.0 as i128;
        assert_eq!(remaining.funding_remainder.0, expected);
        assert!((p.funding_remainder.0 - expected).abs() < PRICE_SCALE as i128);
        balanced(&e);
        e.close_position(U64(pair_id), None, None, None);
        assert!(e.pairs.get(&pair_id).is_none());
        assert_eq!(e.account(&id("alice.testnet")).stats.funding.0, 0);
        assert_eq!(e.account(&id("bob.testnet")).stats.funding.0, 0);
        balanced(&e);
    }
}
#[test]
#[should_panic(expected = "Position not open")]
fn fully_closed_pair_cannot_close_again() {
    let mut e = matched();
    at("alice.testnet", 1, 100);
    e.close_position(U64(0), None, None, None);
    e.close_position(U64(0), None, None, None);
}
#[test]
#[should_panic(expected = "Position not open")]
fn fully_closed_pair_cannot_settle_again() {
    let mut e = matched();
    at("alice.testnet", 1, 100);
    e.close_position(U64(0), None, None, None);
    at("keeper.testnet", 1, 100);
    e.settle_funding(U64(0));
}
