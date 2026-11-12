import { abs, value, type Observation, type Quote } from "../adapters/types";
import type { Policy } from "./policy";
export interface Watch { reason: string | null; delta: bigint; deltaSince: number | null; }
export function watchdog(p: Policy, spot: Observation, perp: Observation, quote: Quote, fundingPpm: bigint, now: number, since: number | null): Watch {
  const delta = spot.position + perp.position;
  const deltaSince = delta === 0n ? null : since ?? now;
  const gross = spot.equity + value(abs(perp.position), quote.price);
  const requiredMargin = value(abs(perp.position), quote.price) * p.minMarginBps / 10_000n;
  const reason = [spot, perp].some(o => o.mode !== "PAPER" || o.at !== now || !o.available || !o.oracleFresh) ? "stale oracle/unavailable venue"
    : spot.position < 0n || perp.position > 0n ? "unexpected direction"
    : perp.capBinding ? "bilateral P&L cap: hedge effectiveness lost"
    : abs(delta) > p.maxDelta || (deltaSince !== null && now - deltaSince >= p.maxDeltaSeconds) ? "delta size/duration limit"
    : gross > p.maxGross ? "gross limit"
    : spot.cash < p.minReserve || perp.cash < p.minReserve ? "reserve exhausted"
    : perp.position !== 0n && perp.equity < requiredMargin ? "margin exhausted"
    : fundingPpm <= 0n && (spot.position !== 0n || perp.position !== 0n) ? "funding reversal"
    : null;
  return { reason, delta, deltaSince };
}
