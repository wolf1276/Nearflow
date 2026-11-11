use crate::{math::*, model::*};
use near_sdk::json_types::{I128, U64, U128};
fn pair() -> Pair {
    Pair {
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
