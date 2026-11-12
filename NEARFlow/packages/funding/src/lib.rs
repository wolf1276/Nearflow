//! Matched-orderbook premium experiment. Signed division truncates toward zero.
use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};
pub const SCALE: i64 = 1_000_000;
pub const CAP: i64 = 2_000;
pub const STEP: i64 = 400;
pub const INTERVAL: u64 = 3600;
pub const MAX_PRICE: u128 = 1_000_000_000_000_000_000_000_000_000;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize,
)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Mode {
    Baseline,
    Adaptive,
}

#[derive(Clone, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Params {
    pub version: u32,
    pub cap_ppm: i64,
    pub step_ppm: i64,
    pub deadband_ppm: i64,
    pub smoothing_ppm: i64,
    pub ema_alpha_ppm: i64,
    pub nonlinear_scale_ppm: i64,
    pub max_premium_ppm: i64,
    pub oracle_max_age_sec: u64,
    pub mark_max_age_sec: u64,
}
impl Default for Params {
    fn default() -> Self {
        Self {
            version: 1,
            cap_ppm: CAP,
            step_ppm: STEP,
            deadband_ppm: 200,
            smoothing_ppm: 200_000,
            ema_alpha_ppm: 500_000,
            nonlinear_scale_ppm: 10_000,
            max_premium_ppm: 100_000,
            oracle_max_age_sec: 60,
            mark_max_age_sec: 300,
        }
    }
}
impl Params {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || !(1..=CAP).contains(&self.cap_ppm)
            || !(1..=self.cap_ppm).contains(&self.step_ppm)
            || !(0..=2000).contains(&self.deadband_ppm)
            || !(1..=SCALE).contains(&self.smoothing_ppm)
            || !(1..=SCALE).contains(&self.ema_alpha_ppm)
            || !(1000..=100_000).contains(&self.nonlinear_scale_ppm)
            || !(2000..=100_000).contains(&self.max_premium_ppm)
            || self.deadband_ppm >= self.max_premium_ppm
            || !(1..=60).contains(&self.oracle_max_age_sec)
            || !(1..=300).contains(&self.mark_max_age_sec)
        {
            return Err("invalid parameters");
        }
        Ok(())
    }
}

/// Index must be independently published; mark must come from a recent matched fill.
/// No OI-skew input exists. Prices use the same 1e18 scale.
pub fn premium(
    index: u128,
    mark: u128,
    index_at: u64,
    mark_at: u64,
    now: u64,
    p: &Params,
) -> Result<i64, &'static str> {
    p.validate()?;
    if index == 0
        || mark == 0
        || index > MAX_PRICE
        || mark > MAX_PRICE
        || index_at > now
        || mark_at > now
        || now - index_at > p.oracle_max_age_sec
        || now - mark_at > p.mark_max_age_sec
    {
        return Err("invalid or stale signal");
    }
    let diff = mark as i128 - index as i128;
    let value = diff * SCALE as i128 / index as i128;
    if value.unsigned_abs() > p.max_premium_ppm as u128 {
        return Err("premium outside bounds");
    }
    Ok(value as i64)
}
pub fn ema(sample: i64, previous: Option<i64>, p: &Params) -> Result<i64, &'static str> {
    p.validate()?;
    if sample.abs_diff(0) > p.max_premium_ppm as u64
        || previous.is_some_and(|old| old.abs_diff(0) > p.max_premium_ppm as u64)
    {
        return Err("signal outside bounds");
    }
    Ok(previous
        .map(|old| old + (sample - old) * p.ema_alpha_ppm / SCALE)
        .unwrap_or(sample))
}
pub fn rate(mode: Mode, premium: i64, previous: i64, p: &Params) -> Result<i64, &'static str> {
    p.validate()?;
    if premium.abs_diff(0) > p.max_premium_ppm as u64 || previous.abs_diff(0) > p.cap_ppm as u64 {
        return Err("signal outside bounds");
    }
    if mode == Mode::Baseline {
        return Ok(premium.clamp(-p.cap_ppm, p.cap_ppm));
    }
    let magnitude = (premium.abs() - p.deadband_ppm).max(0);
    let effective = magnitude * premium.signum();
    let target =
        (effective + effective * magnitude / p.nonlinear_scale_ppm).clamp(-p.cap_ppm, p.cap_ppm);
    let smoothed = previous + (target - previous) * p.smoothing_ppm / SCALE;
    Ok(smoothed
        .clamp(previous - p.step_ppm, previous + p.step_ppm)
        .clamp(-p.cap_ppm, p.cap_ppm))
}
pub fn next_rate(
    mode: Mode,
    premium: i64,
    previous: i64,
    oracle_valid: bool,
) -> Result<i64, &'static str> {
    if !oracle_valid {
        return Err("invalid oracle");
    }
    rate(mode, premium, previous, &Params::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_direction_and_invalid_signals() {
        for premium in (-100_000..=100_000).step_by(137) {
            for previous in (-CAP..=CAP).step_by(101) {
                let r = next_rate(Mode::Adaptive, premium, previous, true).unwrap();
                assert!(r.abs() <= CAP && (r - previous).abs() <= STEP);
                assert_eq!(
                    r,
                    -next_rate(Mode::Adaptive, -premium, -previous, true).unwrap()
                );
            }
        }
        assert!(next_rate(Mode::Adaptive, i64::MIN, 0, true).is_err());
        assert!(next_rate(Mode::Baseline, 0, 0, false).is_err());
    }
    #[test]
    fn continuous_deadband_and_ema() {
        let p = Params::default();
        for x in [199, 200, 201] {
            assert_eq!(rate(Mode::Adaptive, x, 0, &p), Ok(0));
        }
        assert_eq!(ema(1000, None, &p), Ok(1000));
        assert_eq!(ema(-1000, Some(1000), &p), Ok(0));
        assert!(ema(i64::MIN, Some(i64::MAX), &p).is_err());
        assert!(premium(1, MAX_PRICE, 1, 1, 1, &p).is_err());
        assert!(premium(100, 100, 1, 1, 62, &p).is_err());
        assert!(premium(100, 100, 2, 2, 1, &p).is_err());
        let mut bad = p;
        bad.smoothing_ppm = i64::MAX;
        assert!(rate(Mode::Adaptive, 0, 0, &bad).is_err());
    }
    #[test]
    fn shared_stateful_traces_and_mirrors() {
        let traces: serde_json::Value = serde_json::from_str(include_str!("../traces.json")).unwrap();
        let calibrated: serde_json::Value = serde_json::from_str(include_str!("../calibration-vectors.json")).unwrap();
        for trace in traces.as_array().unwrap().iter().chain(calibrated.as_array().unwrap()) {
            let mut params = serde_json::to_value(Params::default()).unwrap();
            for (key, value) in trace["params"].as_object().unwrap() {
                params[key] = value.clone();
            }
            let p: Params = serde_json::from_value(params).unwrap();
            p.validate().unwrap();
            let mode: Mode = serde_json::from_value(trace["mode"].clone()).unwrap();
            for sign in [-1, 1] {
                let mut previous = trace["previous"].as_i64().unwrap() * sign;
                let mut memory = None;
                for (i, sample) in trace["samples"].as_array().unwrap().iter().enumerate() {
                    memory = Some(ema(sample.as_i64().unwrap() * sign, memory, &p).unwrap());
                    assert_eq!(memory.unwrap(), trace["ema"][i].as_i64().unwrap() * sign, "{}", trace["name"]);
                    let next = rate(mode, memory.unwrap(), previous, &p).unwrap();
                    assert_eq!(next, trace["rates"][i].as_i64().unwrap() * sign, "{}", trace["name"]);
                    assert!(next.abs() <= p.cap_ppm);
                    if mode == Mode::Adaptive { assert!((next - previous).abs() <= p.step_ppm); }
                    previous = next;
                }
            }
        }
    }
    #[test]
    fn reference_vectors() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../vectors.json")).unwrap();
        for v in vectors.as_array().unwrap() {
            let mode = if v["mode"] == "BASELINE" {
                Mode::Baseline
            } else {
                Mode::Adaptive
            };
            assert_eq!(
                rate(
                    mode,
                    v["premium"].as_i64().unwrap(),
                    v["previous"].as_i64().unwrap(),
                    &Params::default()
                )
                .unwrap(),
                v["rate"].as_i64().unwrap()
            );
        }
    }
}
