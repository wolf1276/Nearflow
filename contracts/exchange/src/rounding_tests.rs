use crate::{math::*, model::*};
use near_sdk::json_types::{I128, U64, U128};
fn pair() -> Pair {
    Pair { long_strategy_id: None, short_strategy_id: None,
        id: U64(0),
        market_id: 1,
        long: "alice.testnet".parse().unwrap(),
        short: "bob.testnet".parse().unwrap(),
        size: U128(10_000),
        entry_price: U128(100 * PRICE_SCALE),
        long_margin: U128(10_000_000),
        short_margin: U128(10_000_000),
        last_funding_index: I128(0),
        funding_remainder: I128(0),
    }
}
fn settle(p: &mut Pair, index: i128) -> i128 {
    let (payment, remainder) = funding_settlement(p, index);
    p.long_margin.0 = (p.long_margin.0 as i128 - payment) as u128;
    p.short_margin.0 = (p.short_margin.0 as i128 + payment) as u128;
    p.last_funding_index = I128(index);
    p.funding_remainder = I128(remainder);
    payment
}
#[test]
fn paper_feedback_accounting_vectors_match_contract() {
    let vectors: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(
        include_str!("../../../packages/sim/accounting-vectors.json")
    ).unwrap();
    for vector in vectors.as_array().unwrap() {
        let value = |key: &str| vector[key].as_str().unwrap().parse::<i128>().unwrap();
        let mut p = pair();
        p.size = U128(value("size") as u128);
        p.entry_price = U128(value("entry") as u128);
        p.long_margin = U128(value("longMargin") as u128);
        p.short_margin = U128(value("shortMargin") as u128);
        p.last_funding_index = I128(value("checkpoint"));
        p.funding_remainder = I128(value("remainder"));
        let (payment, remainder) = funding_settlement(&p, value("index"));
        assert_eq!(payment, value("payment"));
        assert_eq!(remainder, value("nextRemainder"));
        p.long_margin = U128((p.long_margin.0 as i128 - payment) as u128);
        p.short_margin = U128((p.short_margin.0 as i128 + payment) as u128);
        let result = payout(&p, value("price") as u128);
        assert_eq!(result.0, value("longPayout") as u128);
        assert_eq!(result.1, value("shortPayout") as u128);
    }
}
#[test]
fn frequent_settlement_cannot_erase_subunit_funding() {
    let original = pair();
    let mut p = original.clone();
    let mut paid = 0;
    for n in 1..=100 {
        paid += settle(&mut p, n * 1_000_000_000_000);
    }
    assert_eq!(paid, 1);
    assert_eq!(paid, funding_payment(&original, 100_000_000_000_000));
    assert_eq!(p.funding_remainder.0, 0);
    assert_eq!(p.long_margin.0 + p.short_margin.0, 20_000_000);
}
#[test]
fn seeded_settlement_matches_independent_integer_reference() {
    let mut seed = 0x7265666c6578u64;
    let mut next = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        seed
    };
    for case in 0..64 {
        let mut p = pair();
        p.size = U128([1, 10_000, 1_000_000_000][case % 3]);
        p.long_margin = U128(if case % 2 == 0 { 1 } else { 1_000_000_000_000 });
        p.short_margin = U128(if case % 5 == 0 { 1 } else { 1_000_000_000_000 });
        let total = p.long_margin.0 + p.short_margin.0;
        let mut index = 0i128;
        for _ in 0..200 {
            let delta = (next() as i64 as i128) * 1_000_000;
            index += delta;
            // i128 is sufficient for these size/delta bounds; independent of U256 splitting.
            let numerator = p.size.0 as i128 * delta + p.funding_remainder.0;
            let owed = numerator / PRICE_SCALE as i128;
            let expected = owed.clamp(-(p.short_margin.0 as i128), p.long_margin.0 as i128);
            let remainder = if owed == expected { numerator % PRICE_SCALE as i128 } else { 0 };
            assert_eq!(settle(&mut p, index), expected, "case {case}");
            assert_eq!(p.funding_remainder.0, remainder);
            assert_eq!(p.long_margin.0 + p.short_margin.0, total);
            assert!(p.funding_remainder.0.abs() < PRICE_SCALE as i128);
            let before = (p.long_margin, p.short_margin, p.funding_remainder);
            assert_eq!(settle(&mut p, index), 0);
            assert_eq!((p.long_margin, p.short_margin, p.funding_remainder), before);
        }
    }
}
#[test]
fn funding_remainder_handles_rate_reversal() {
    let mut p = pair();
    let mut paid = 0;
    for index in [150_000_000_000_000, 50_000_000_000_000, 0] {
        paid += settle(&mut p, index);
    }
    assert_eq!(paid, 0);
    assert_eq!(p.funding_remainder.0, 0);
    assert_eq!(p.long_margin.0, 10_000_000);
}
