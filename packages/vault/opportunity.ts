import { abs, fresh, value, type Quote } from "../adapters/types";
import type { Policy } from "../risk/policy";
export interface Opportunity {
  at: number; epoch: number; configRevision: number; fundingPpm: bigint; fundingExpiresAt?: number;
  horizonSeconds: number; collectibleSeconds: number; payerCollateral: bigint;
  basisChange: bigint; repairCost: bigint; reserveCost: bigint; exitCost: bigint;
  spotCash: bigint; perpCash: bigint; size: bigint; spot: Quote; perp: Quote;
}
export interface Evaluation { allowed: boolean; reason: string; funding: bigint; costs: bigint; net: bigint; gross: bigint; margin: bigint; }
export function evaluate(p: Policy, o: Opportunity, now: number): Evaluation {
  const no = (reason: string): Evaluation => ({ allowed: false, reason, funding: 0n, costs: 0n, net: 0n, gross: 0n, margin: 0n });
  if (![o.at, o.epoch, o.configRevision, o.horizonSeconds, o.collectibleSeconds, now].every(Number.isSafeInteger) || o.at !== now || o.epoch < 0 || o.configRevision < 1 || o.horizonSeconds <= 0 || o.horizonSeconds > 86_400 || o.collectibleSeconds < 0 || o.collectibleSeconds > o.horizonSeconds) return no("invalid horizon/snapshot");
  if (o.fundingExpiresAt !== undefined && (!Number.isSafeInteger(o.fundingExpiresAt) || o.fundingExpiresAt <= now)) return no("expired funding observation");
  if (!fresh(o.spot, now) || !fresh(o.perp, now) || o.spot.leg !== "spot" || o.perp.leg !== "perp" || o.spot.market !== o.perp.market) return no("stale/unavailable/mixed quote");
  if ([o.size, o.spotCash, o.perpCash, o.payerCollateral, o.repairCost, o.reserveCost, o.exitCost].some(n => typeof n !== "bigint" || n < 0n || n > 10n ** 30n) || o.size === 0n || o.fundingPpm <= 0n || o.fundingPpm > 100_000n || o.basisChange > 0n) return no("invalid or optimistic assumptions");
  if (abs(o.spot.price - o.perp.price) * 10_000n > (o.spot.price < o.perp.price ? o.spot.price : o.perp.price) * 300n) return no("spot/perp price divergence");
  if (!p.autoOpen) return no("auto-open disabled");
  if (o.size * 10_000n > o.spot.depth * p.maxParticipationBps || o.size * 10_000n > o.perp.depth * p.maxParticipationBps) return no("insufficient depth");
  if (o.spot.slippageBps > p.maxSlippageBps || o.perp.slippageBps > p.maxSlippageBps) return no("slippage limit");
  const spot = value(o.size, o.spot.price), perp = value(o.size, o.perp.price);
  const gross = spot + perp;
  const margin = (perp * p.minMarginBps + 9999n) / 10_000n;
  const entry = (spot * (o.spot.feeBps + o.spot.slippageBps) + 9999n) / 10_000n + (perp * (o.perp.feeBps + o.perp.slippageBps) + 9999n) / 10_000n;
  const costs = entry + o.exitCost + o.repairCost + o.reserveCost;
  const uncapped = perp * o.fundingPpm * BigInt(o.collectibleSeconds) / 3_600_000_000n;
  const funding = uncapped < o.payerCollateral ? uncapped : o.payerCollateral;
  const net = funding + o.basisChange - costs;
  const reason = gross > p.maxGross ? "gross limit" : o.spotCash < spot + entry + p.minReserve || o.perpCash < margin + entry + p.minReserve ? "insufficient collateral/reserve" : entry > p.maxActionCost || costs > p.maxTotalCost ? "cost budget" : net < p.minNetCarry || net <= 0n ? "non-positive conservative net carry" : "eligible; uncertain horizon and early close risk";
  return { allowed: reason.startsWith("eligible"), reason, funding, costs, net, gross, margin };
}
