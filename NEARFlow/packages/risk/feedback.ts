import { abs, fresh, value, type Quote } from "../adapters/types";
import { hash } from "../vault/store";
import type { Signal } from "../../services/guardian/funding-source";

export interface FeedbackPolicy {
  version: 1; contract: string; scope: Signal["scope"]; marketId: number;
  entryPpm: bigint; exitPpm: bigint; persistenceEpochs: number; cooldownSeconds: number;
  maxEpochGross: bigint; maxDailyGross: bigint; maxEpochCosts: bigint;
  maxParticipationBps: bigint; horizonSeconds: number; repairCost: bigint; reserveCost: bigint;
}
export interface FeedbackState {
  epoch: number; revision: number; streak: number; lastAction: number | null;
  entries: number; epochGross: bigint; epochCosts: bigint; day: number; dailyGross: bigint;
}
export function feedbackHash(p: FeedbackPolicy) {
  const keys: (keyof FeedbackPolicy)[] = ["version", "contract", "scope", "marketId", "entryPpm", "exitPpm", "persistenceEpochs", "cooldownSeconds", "maxEpochGross", "maxDailyGross", "maxEpochCosts", "maxParticipationBps", "horizonSeconds", "repairCost", "reserveCost"];
  if (Object.keys(p).length !== keys.length || keys.some(k => !Object.hasOwn(p, k))) throw Error("Invalid feedback schema");
  if (p.version !== 1 || !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet$/.test(p.contract) || p.contract.length > 64 || !["LOCAL_FIXTURE", "LOCAL_SANDBOX", "NEAR_TESTNET"].includes(p.scope)
    || !Number.isSafeInteger(p.marketId) || p.marketId <= 0 || p.marketId > 0xffff_ffff) throw Error("Invalid feedback identity");
  for (const key of ["entryPpm", "exitPpm", "maxEpochGross", "maxDailyGross", "maxEpochCosts", "maxParticipationBps", "repairCost", "reserveCost"] as const) if (typeof p[key] !== "bigint" || p[key] < 0n || p[key] > 10n ** 30n) throw Error("Invalid feedback amount");
  if (p.entryPpm <= p.exitPpm || p.entryPpm > 2000n || p.maxEpochGross === 0n || p.maxDailyGross < p.maxEpochGross || p.maxParticipationBps < 1n || p.maxParticipationBps > 10_000n
    || !Number.isSafeInteger(p.persistenceEpochs) || p.persistenceEpochs < 2 || p.persistenceEpochs > 24
    || !Number.isSafeInteger(p.cooldownSeconds) || p.cooldownSeconds < 1 || p.cooldownSeconds > 86_400
    || !Number.isSafeInteger(p.horizonSeconds) || p.horizonSeconds < 1 || p.horizonSeconds > 3600) throw Error("Invalid feedback bounds");
  return hash(Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))));
}
export function advanceFeedback(p: FeedbackPolicy, previous: FeedbackState, signal: Signal, now: number): FeedbackState {
  const s = { ...previous };
  const day = Math.floor(now / 86_400);
  if (day > s.day) { s.day = day; s.dailyGross = 0n; }
  if (signal.epoch > s.epoch) {
    s.streak = signal.usable && signal.ppm >= p.entryPpm ? signal.epoch === s.epoch + 1 && signal.revision === s.revision ? Math.min(p.persistenceEpochs, s.streak + 1) : 1 : 0;
    s.epoch = signal.epoch; s.revision = signal.revision; s.entries = 0; s.epochGross = 0n; s.epochCosts = 0n;
  } else if (!signal.usable || signal.revision !== s.revision || signal.ppm < p.entryPpm) {
    s.streak = 0; s.revision = signal.revision;
  }
  return s;
}
export function entryReason(p: FeedbackPolicy, s: FeedbackState, signal: Signal, now: number): string | null {
  return !signal.usable ? signal.inactiveReason ?? "inactive funding"
    : signal.ppm < p.entryPpm ? "entry threshold"
    : s.streak < p.persistenceEpochs ? "funding persistence"
    : s.entries >= 1 ? "one market entry per epoch; no recursive funding chase"
    : s.lastAction !== null && now - s.lastAction < p.cooldownSeconds ? "market cooldown" : null;
}
export function quoteReason(p: FeedbackPolicy, signal: Signal, spot: Quote, perp: Quote, now: number): string | null {
  if (!fresh(spot, now) || !fresh(perp, now) || spot.leg !== "spot" || perp.leg !== "perp" || spot.market !== `${signal.symbol}/USD` || perp.market !== spot.market) return "stale/unavailable/wrong market quotes";
  const index = signal.indexPrice / 10n ** 12n;
  if (!index || [spot, perp].some(q => abs(q.price - index) * 10_000n > index * 300n)) return "quotes diverge from finalized index";
  if (spot.depth === 0n || perp.depth === 0n) return "depleted executable depth";
  return null;
}
export function projectedCosts(size: bigint, spot: Quote, perp: Quote) {
  return ([spot, perp]).reduce((cost, q) => cost + (value(size, q.price) * (q.feeBps + q.slippageBps) + 9999n) / 10_000n, 0n);
}
