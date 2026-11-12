use crate::*;
use nearflow_funding::{INTERVAL, Mode, Params, ema, premium, rate};

#[near]
impl Exchange {
    /// Permissionless application of contract-derived signals, never caller-supplied prices.
    /// Epoch is the current UTC hour; missed hours are not replayed or backfilled.
    #[payable]
    pub fn update_funding(&mut self, market_id: u32, epoch: U64) {
        assert_one_yocto();
        let now = now();
        let mut m = self.fresh_market(market_id);
        assert_eq!(epoch.0, now / INTERVAL, "Expected current funding epoch");
        assert!(
            m.controller.last_epoch.is_none_or(|old| epoch.0 > old),
            "Funding epoch already applied"
        );
        let signal = self
            .recent_market_trade(market_id)
            .ok_or("missing mark")
            .and_then(|t| {
                premium(
                    m.price.0,
                    t.price.0,
                    m.timestamp,
                    t.timestamp,
                    now,
                    &m.controller.params,
                )
            });
        // Accrue the OLD rate and price before changing any controller state.
        m.funding_index = I128(funding_index(&m, now));
        m.funding_updated_at = now;
        let next = match signal {
            Ok(sample) => {
                let smoothed = ema(sample, m.controller.premium_ema_ppm, &m.controller.params)
                    .expect("Validated EMA");
                m.controller.premium_ema_ppm = Some(smoothed);
                m.controller.fallback = false;
                rate(
                    m.controller.mode,
                    smoothed,
                    m.funding_rate_ppm,
                    &m.controller.params,
                )
                .expect("Validated controller")
            }
            Err(_) => {
                // Missing/stale/divergent mark: explicit zero-rate fallback, no synthetic index.
                m.controller.premium_ema_ppm = None;
                m.controller.fallback = true;
                0
            }
        };
        m.funding_rate_ppm = next;
        m.funding_rate_bps = (next / 100) as i32;
        m.controller.rate_applied_at = now;
        m.controller.last_epoch = Some(epoch.0);
        self.markets.insert(&market_id, &m);
        event(
            "funding_controller",
            json!({"market_id": market_id, "epoch": epoch,
            "rate_ppm": next, "interval_sec": INTERVAL, "controller": m.controller}),
        );
    }

    /// A configuration change freezes accrued history and resets the rate to zero.
    /// It cannot reset the epoch or trigger another rate step within the same hour.
    #[payable]
    pub fn configure_funding(
        &mut self,
        market_id: u32,
        mode: Mode,
        params: Params,
        expected_revision: u32,
    ) {
        self.assert_owner();
        assert_one_yocto();
        params.validate().expect("Invalid funding parameters");
        let mut m = self.market(market_id);
        assert_eq!(
            expected_revision, m.controller.revision,
            "Configuration revision mismatch"
        );
        let revision = expected_revision.checked_add(1).expect("Revision overflow");
        let now = now();
        m.funding_index = I128(funding_index(&m, now));
        m.funding_updated_at = now;
        m.funding_rate_ppm = 0;
        m.funding_rate_bps = 0;
        m.controller.mode = mode;
        m.controller.params = params;
        m.controller.revision = revision;
        m.controller.rate_applied_at = now;
        m.controller.premium_ema_ppm = None;
        m.controller.fallback = true;
        // Consume this epoch even if no update was applied yet: configuration is
        // not a way to bypass cadence or repeatedly initialize an adaptive rate.
        m.controller.last_epoch = Some(now / INTERVAL);
        self.markets.insert(&market_id, &m);
        event(
            "funding_configuration",
            json!({"market_id": market_id, "controller": m.controller}),
        );
    }
}
