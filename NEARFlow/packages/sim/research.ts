import { type Metrics } from './feedback';
export interface Row { profile: string; mode: 'BASELINE' | 'ADAPTIVE'; vault: boolean; sensitivity: string;
  split: 'train' | 'holdout'; scenario: string; seed: number; sign: number; metrics: Metrics }
export interface Aggregate extends Omit<Row, 'seed' | 'sign'> { runs: number; worstPnl: bigint }
const caseKey = (r: Row) => [r.split, r.scenario, r.seed, r.sign, r.vault, r.sensitivity].join('/');
export function regressions(a: Metrics, b: Metrics) {
  return { premium: a.premiumAbsPpm > b.premiumAbsPpm || a.peakPremiumPpm > b.peakPremiumPpm,
    pnl: a.vaultNetPnl < b.vaultNetPnl, drawdown: a.maxDrawdown > b.maxDrawdown,
    costs: a.costs > b.costs, exposure: a.breachHours > b.breachHours || a.maxDeltaAfterStep > b.maxDeltaAfterStep,
    liquidation: a.liquidations > b.liquidations, fundingVariation: a.rateVariationPpm > b.rateVariationPpm };
}
export function decision(rows: Row[]) {
  const baseline = rows.filter(r => r.profile === 'default' && r.mode === 'BASELINE');
  const references = new Map(baseline.map(r => [caseKey(r), r.metrics]));
  if (references.size !== baseline.length) throw new Error('duplicate baseline case');
  const trainCases = baseline.filter(r => r.split === 'train').length;
  const holdoutCases = baseline.filter(r => r.split === 'holdout').length;
  const ids = [...new Set(rows.map(r => r.profile))];
  const review = ids.map(profile => {
    const result = { profile, trainCases: 0, holdoutCases: 0, trainFailures: 0, holdoutFailures: 0, trainImproved: 0, holdoutImproved: 0,
      reasons: { premium: 0, pnl: 0, drawdown: 0, costs: 0, exposure: 0, liquidation: 0, fundingVariation: 0 }, trainPremium: 0n };
    const seen = new Set<string>();
    for (const row of rows.filter(r => r.profile === profile && r.mode === 'ADAPTIVE')) {
      if (seen.has(caseKey(row))) throw new Error('duplicate candidate case');
      seen.add(caseKey(row));
      const reference = references.get(caseKey(row));
      if (!reference) throw new Error('missing identical-input baseline');
      const failures = regressions(row.metrics, reference);
      const failed = Object.values(failures).some(Boolean);
      if (row.split === 'train') {
        result.trainCases++;
        result.trainFailures += Number(failed);
        result.trainImproved += Number(row.metrics.premiumAbsPpm < reference.premiumAbsPpm);
        result.trainPremium += row.metrics.premiumAbsPpm;
      } else {
        result.holdoutCases++;
        result.holdoutFailures += Number(failed);
        result.holdoutImproved += Number(row.metrics.premiumAbsPpm < reference.premiumAbsPpm);
      }
      for (const key of Object.keys(failures) as (keyof typeof failures)[]) result.reasons[key] += Number(failures[key]);
    }
    return result;
  });
  const eligible = review.filter(r => r.trainCases === trainCases && trainCases > 0 && r.trainFailures === 0 && r.trainImproved > 0)
    .sort((a, b) => a.trainPremium < b.trainPremium ? -1 : a.trainPremium > b.trainPremium ? 1 : a.profile.localeCompare(b.profile));
  const trainWinner = eligible[0];
  return { trainWinner: trainWinner?.profile ?? null,
    selected: trainWinner && trainWinner.holdoutCases === holdoutCases && holdoutCases > 0 && trainWinner.holdoutFailures === 0 ? trainWinner.profile : null, review };
}
export function aggregate(rows: Row[]): Aggregate[] {
  const groups = new Map<string, Aggregate>();
  for (const row of rows) {
    const key = [row.profile, row.mode, row.vault, row.sensitivity, row.split, row.scenario].join('/');
    const prior = groups.get(key);
    if (!prior) {
      const { seed, sign, ...rest } = row;
      void seed; void sign;
      groups.set(key, { ...rest, metrics: { ...row.metrics }, runs: 1, worstPnl: row.metrics.vaultNetPnl });
      continue;
    }
    prior.runs++;
    if (row.metrics.vaultNetPnl < prior.worstPnl) prior.worstPnl = row.metrics.vaultNetPnl;
    for (const field of Object.keys(row.metrics) as (keyof Metrics)[]) {
      const a = prior.metrics[field], b = row.metrics[field];
      const max = field.startsWith('max') || field.startsWith('peak');
      const value = field === 'minMarginRatioPpm' ? (a < b ? a : b) : max ? (a > b ? a : b)
        : typeof a === 'bigint' && typeof b === 'bigint' ? a + b : Number(a) + Number(b);
      // Both operands have the same type for every metric key.
      (prior.metrics as unknown as Record<string, number | bigint>)[field] = value;
    }
  }
  return [...groups.values()];
}
export function csv(rows: Row[]) {
  if (!rows.length) throw new Error('empty export');
  const keys = Object.keys(rows[0].metrics) as (keyof Metrics)[];
  return ['profile,mode,vault,sensitivity,split,scenario,seed,sign,' + keys.join(','),
    ...rows.map(r => [r.profile, r.mode, Number(r.vault), r.sensitivity, r.split, r.scenario, r.seed, r.sign,
      ...keys.map(key => r.metrics[key])].join(','))].join('\n') + '\n';
}
