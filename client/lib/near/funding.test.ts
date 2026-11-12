import test from "node:test";
import assert from "node:assert/strict";
import { fundingView, oracleFresh, displayedFunding, fundingBps } from "./funding";
import type { ChainMarket } from "./types";

export const market: ChainMarket = {
  market_id: 1, symbol: "NEAR", initial_margin_bps: 1000, maintenance_margin_bps: 500,
  max_open_interest: "1000000", open_interest: "0", price: "1000000000000000000",
  timestamp: 100, last_price: "0", funding_index: "0", funding_rate_bps: 20,
  funding_rate_ppm: 2000, paused: false, controller: { mode: "BASELINE", revision: 1,
    last_epoch: 0, fallback: false, rate_applied_at: 100, params: { oracle_max_age_sec: 10 } },
};

test("configured oracle TTL is inclusive and future/zero prices are never fresh", () => {
  for (const [time, fresh] of [[99, false], [100, true], [110, true], [111, false]] as const)
    assert.equal(oracleFresh(market, time), fresh);
  assert.equal(oracleFresh({ ...market, price: "0" }, 100), false);
});

test("stored quote differs from accrual at the exact expiry boundary", () => {
  assert.equal(fundingView(market, 109).effective_funding_rate_ppm, 2000);
  const expired = fundingView(market, 110);
  assert.equal(expired.effective_funding_rate_ppm, 0);
  assert.equal(expired.stored_funding_rate_ppm, 2000);
  assert.equal(expired.funding_inactive_reason, "RATE_EXPIRED");
  assert.equal(fundingView(market, 111).funding_inactive_reason, "ORACLE_STALE");
});

test("fresh oracle cannot revive an expired hourly rate; restart requires a new application", () => {
  const fresh = { ...market, timestamp: 3700 };
  assert.equal(oracleFresh(fresh, 3700), true);
  assert.equal(fundingView(fresh, 3700).funding_inactive_reason, "RATE_EXPIRED");
  assert.equal(fundingView({ ...fresh, controller: { ...market.controller!, rate_applied_at: 3700 } }, 3700).funding_rate, 0.002);
});

test("browser display cannot revive API-denied quotes and expires cached rates locally", () => {
  const quote = { ...market, ...fundingView(market, 100) };
  assert.deepEqual(displayedFunding(quote, 100), { rate: 2000, reason: null });
  assert.equal(displayedFunding(quote, 110).rate, 0);
  assert.equal(displayedFunding({ ...quote, funding_inactive_reason: "RATE_EXPIRED", effective_funding_rate_ppm: 0 }, 100).rate, 0);
  assert.equal(fundingBps(2000), "+20.00 bps/hour");
  assert.equal(fundingBps(-4), "-0.04 bps/hour");
});
test("both signs, fallback and missing/future rate metadata fail safely", () => {
  assert.equal(fundingView({ ...market, funding_rate_ppm: -2000 }, 100).funding_rate, -0.002);
  assert.equal(fundingView({ ...market, controller: { ...market.controller!, fallback: true } }, 100).funding_inactive_reason, "ZERO_FALLBACK");
  assert.equal(fundingView({ ...market, controller: undefined }, 100).funding_rate, 0);
  assert.equal(fundingView({ ...market, controller: { ...market.controller!, rate_applied_at: 101 } }, 100).funding_rate, 0);
});
