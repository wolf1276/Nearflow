use crate::model::*;
use uint::construct_uint;
construct_uint! { pub struct U256(4); }

pub fn mul_div(a: u128, b: u128, divisor: u128) -> u128 {
    assert!(divisor > 0, "Zero divisor");
    let result = U256::from(a) * U256::from(b) / U256::from(divisor);
    assert!(result <= U256::from(u128::MAX), "Math overflow");
    result.low_u128()
}
pub fn ceil_div(a: u128, b: u128) -> u128 {
    a / b + u128::from(a % b != 0)
}
pub fn notional(size: u128, price: u128) -> u128 {
    mul_div(size, price, PRICE_SCALE)
}
pub fn signed_amount(size: u128, delta: i128) -> i128 {
    let n =
        i128::try_from(mul_div(size, delta.unsigned_abs(), PRICE_SCALE)).expect("Signed overflow");
    if delta < 0 { -n } else { n }
}
pub fn raw_pnl(p: &Pair, price: u128) -> i128 {
    signed_amount(
        p.size.0,
        i128::try_from(price).unwrap() - i128::try_from(p.entry_price.0).unwrap(),
    )
}
pub fn funding_index(m: &Market, now: u64) -> i128 {
    // Charge at the last rate for at most the valid lifetime of its oracle price.
    // A keeper outage must not accumulate unbounded charges using stale data.
    let end = now.min(m.timestamp.saturating_add(ORACLE_MAX_AGE));
    let elapsed = end.saturating_sub(m.funding_updated_at);
    let delta = mul_div(
        m.price.0,
        m.funding_rate_bps.unsigned_abs() as u128 * elapsed as u128,
        10_000 * 3600,
    );
    m.funding_index
        .0
        .checked_add(if m.funding_rate_bps < 0 {
            -(delta as i128)
        } else {
            delta as i128
        })
        .expect("Funding overflow")
}
pub fn funding_settlement(p: &Pair, index: i128) -> (i128, i128) {
    let delta = index - p.last_funding_index.0;
    let product = U256::from(p.size.0) * U256::from(delta.unsigned_abs());
    let fraction = (product % U256::from(PRICE_SCALE)).low_u128() as i128;
    let mut whole = signed_amount(p.size.0, delta);
    let residual = p.funding_remainder.0 + if delta < 0 { -fraction } else { fraction };
    whole += residual / PRICE_SCALE as i128;
    let mut remainder = residual % PRICE_SCALE as i128;
    // Normalize toward zero when the funding rate changes sign.
    if whole > 0 && remainder < 0 {
        whole -= 1;
        remainder += PRICE_SCALE as i128;
    }
    if whole < 0 && remainder > 0 {
        whole += 1;
        remainder -= PRICE_SCALE as i128;
    }
    let payment = whole.clamp(-(p.short_margin.0 as i128), p.long_margin.0 as i128);
    (payment, if payment == whole { remainder } else { 0 })
}
pub fn funding_payment(p: &Pair, index: i128) -> i128 {
    funding_settlement(p, index).0
}
pub fn funded_margins(p: &Pair, index: i128) -> (u128, u128) {
    let payment = funding_payment(p, index);
    (
        (p.long_margin.0 as i128 - payment) as u128,
        (p.short_margin.0 as i128 + payment) as u128,
    )
}
pub fn payout(p: &Pair, price: u128) -> (u128, u128, i128) {
    let pnl = raw_pnl(p, price).clamp(-(p.long_margin.0 as i128), p.short_margin.0 as i128);
    (
        (p.long_margin.0 as i128 + pnl) as u128,
        (p.short_margin.0 as i128 - pnl) as u128,
        pnl,
    )
}
pub fn is_liquidatable(p: &Pair, m: &Market) -> (bool, bool) {
    let maintenance = mul_div(
        notional(p.size.0, m.price.0),
        m.maintenance_margin_bps as u128,
        10_000,
    )
    .max(1);
    let (long, short, _) = payout(p, m.price.0);
    (long <= maintenance, short <= maintenance)
}
pub fn liquidation_price(p: &Pair, m: &Market, long: bool) -> u128 {
    let entry = notional(p.size.0, p.entry_price.0);
    let numerator = if long {
        entry.saturating_sub(p.long_margin.0)
    } else {
        entry + p.short_margin.0
    };
    let factor = if long {
        10_000 - m.maintenance_margin_bps as u128
    } else {
        10_000 + m.maintenance_margin_bps as u128
    };
    mul_div(numerator, PRICE_SCALE * 10_000, p.size.0 * factor)
}
