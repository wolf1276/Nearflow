import type { Policy } from "../risk/policy";
import { evaluate, type Evaluation, type Opportunity } from "./opportunity";

/** Largest integer size inside collateral/depth/cost caps, then require net carry.
 * No scaling up from the owner's requested maximum and no optimistic basis gain.
 */
export function sizeHedge(p: Policy, o: Opportunity, now: number): { size: bigint; evaluation: Evaluation } {
  const requested = evaluate(p, o, now);
  if (["expired funding observation", "invalid horizon/snapshot", "stale/unavailable/mixed quote", "invalid or optimistic assumptions", "auto-open disabled", "spot/perp price divergence"].includes(requested.reason)) return { size: o.size, evaluation: requested };
  let low = 0n, high = o.size < p.maxDelta ? o.size : p.maxDelta;
  if (high < 0n || high > 10n ** 30n) return { size: 0n, evaluation: evaluate(p, { ...o, size: 0n }, now) };
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const e = evaluate(p, { ...o, size: mid }, now);
    // Net carry is checked after capacity sizing; fixed costs make it non-monotonic near zero.
    if (e.allowed || e.reason === "non-positive conservative net carry") low = mid;
    else high = mid - 1n;
  }
  const evaluation = evaluate(p, { ...o, size: low }, now);
  return { size: low, evaluation };
}
