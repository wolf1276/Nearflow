import type { ChainMarket } from "./types";

export const oracleExpiresAt = (m: ChainMarket) => m.timestamp + (m.controller?.params.oracle_max_age_sec ?? 60);

export function oracleFresh(m: ChainMarket, now: number): boolean {
  const ttl = m.controller?.params.oracle_max_age_sec ?? 60;
  return BigInt(m.price) > 0n && Number.isSafeInteger(m.timestamp)
    && m.timestamp <= now && now - m.timestamp <= ttl;
}

/** Stored quotes survive outages; only the effective rate describes accrual now. */
export function fundingView(m: ChainMarket, now: number, observedAt = now) {
  const applied = m.controller?.rate_applied_at;
  const expires = applied === undefined ? null : Math.min(oracleExpiresAt(m), applied + 3600);
  const reason = !oracleFresh(m, now) || !oracleFresh(m, observedAt) ? "ORACLE_STALE"
    : applied === undefined || applied > now ? "RATE_UNAVAILABLE"
    : expires === null || Math.max(now, observedAt) >= expires ? "RATE_EXPIRED"
    : m.controller?.fallback ? "ZERO_FALLBACK" : null;
  const stored = m.funding_rate_ppm ?? m.funding_rate_bps * 100;
  const effective = reason === null ? stored : 0;
  return { stored_funding_rate_ppm: stored, effective_funding_rate_ppm: effective,
    funding_rate: effective / 1_000_000, funding_expires_at: expires, funding_inactive_reason: reason,
    funding_as_of: now };
}
export type FundingMarket = ChainMarket & ReturnType<typeof fundingView>;

export function displayedFunding(m: FundingMarket, now: number) {
  const local = fundingView(m, m.funding_as_of, now);
  const reason = m.funding_inactive_reason ?? local.funding_inactive_reason;
  return { reason, rate: reason ? 0 : m.effective_funding_rate_ppm };
}

export const fundingBps = (ppm: number) => `${ppm > 0 ? '+' : ''}${(ppm / 100).toFixed(2)} bps/hour`;
