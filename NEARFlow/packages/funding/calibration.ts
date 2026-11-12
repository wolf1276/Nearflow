import { defaults, ema, nextRate, premium, validate, type Params } from './preview';

export const CALIBRATION_VERSION = 1;
export const TRAIN_SEEDS = [7, 41, 2026];
export const HOLDOUT_SEEDS = [101, 503, 9001];
export const SCENARIOS = ['noise', 'persistent', 'reversal', 'spike', 'sparse', 'bursts', 'outage', 'manipulated'] as const;
export type Scenario = typeof SCENARIOS[number];
export interface Observation {
  at: number; indexAt: number; markAt: number; index: bigint; mark: bigint;
}
export interface Candidate { id: string; params: Params }
export interface Metrics {
  observations: number; applied: number; valid: number; fallback: number; oracleRejected: number; replayRejected: number;
  trackingErrorPpmSum: number; variationPpm: number; peakPpm: number; maxNormalStepPpm: number;
  wrongSign: number; maxWrongSignRun: number; noiseAbsPpmSum: number; noiseCount: number;
}
export interface Result { id: string; mode: 'BASELINE' | 'ADAPTIVE'; split: 'train' | 'holdout'; metrics: Metrics }
export const encode = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const abs = (value: bigint) => value < 0n ? -value : value;
const target = (sample: bigint) => sample < -2000n ? -2000n : sample > 2000n ? 2000n : sample;

/** Exogenous controller inputs only: no simulated fills, balances, market impact or hedge profitability. */
export function observations(scenario: Scenario, seed: number, sign = 1): Observation[] {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const rows: Observation[] = [];
  for (let hour = 0; hour < 32; hour++) {
    const jitter = Number(random() % 401) - 200;
    let sample = scenario === 'noise' ? jitter
      : scenario === 'persistent' ? 4000 + jitter
      : scenario === 'reversal' ? (hour < 16 ? 10000 : -10000) + jitter
      : scenario === 'spike' ? (hour === 8 ? 80000 : hour === 9 ? -80000 : jitter)
      : scenario === 'bursts' ? (hour % 2 ? -10000 : 10000) + jitter
      : scenario === 'manipulated' ? (hour % 8 === 0 ? 100001 : hour % 8 === 1 ? -100001 : jitter)
      : 4000 + jitter;
    sample *= sign;
    const at = hour * 3600 + (scenario === 'bursts' ? 0 : 100);
    const row: Observation = { at, indexAt: at, markAt: at, index: 10n ** 24n,
      mark: 10n ** 24n * (1_000_000n + BigInt(sample)) / 1_000_000n };
    if (scenario === 'sparse' && hour % 4 !== 0) row.markAt -= 301;
    if (scenario === 'sparse' && hour % 4 === 2) row.mark = 0n;
    if (scenario === 'outage' && hour >= 10 && hour <= 14) row.indexAt -= 61;
    if (scenario === 'manipulated' && hour % 8 === 2) row.markAt += 1;
    rows.push(row);
    if (scenario === 'bursts') {
      rows.push({ ...row, at: at + 1, markAt: at + 1, mark: 2n * row.index - row.mark });
      const boundary = hour * 3600 + 3599;
      rows.push({ ...row, at: boundary, indexAt: boundary, markAt: boundary });
    }
  }
  return rows;
}

export function measure(rows: Observation[], mode: Result['mode'], params: Params, noise = false): Metrics {
  validate(params);
  const m: Metrics = { observations: 0, applied: 0, valid: 0, fallback: 0, oracleRejected: 0, replayRejected: 0,
    trackingErrorPpmSum: 0, variationPpm: 0, peakPpm: 0, maxNormalStepPpm: 0,
    wrongSign: 0, maxWrongSignRun: 0, noiseAbsPpmSum: 0, noiseCount: 0 };
  let memory: bigint | undefined;
  let stored = 0n, effective = 0n, epoch = -1, appliedAt = -3600, wrongRun = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.at) || row.at < 0) throw new Error('invalid observation time');
    m.observations++;
    const fresh = row.index > 0n && row.index <= 10n ** 27n && row.indexAt <= row.at
      && row.indexAt >= 0 && row.at - row.indexAt <= Number(params.oracle_max_age_sec);
    let sample: bigint | undefined;
    if (!fresh) { m.oracleRejected++; wrongRun = 0; }
    else if (Math.floor(row.at / 3600) <= epoch) m.replayRejected++;
    else {
      try { sample = premium(row.index, row.mark, BigInt(row.indexAt), BigInt(row.markAt), BigInt(row.at), params); }
      catch { /* Contract signal failure is a zero fallback, not an invented observation. */ }
      if (sample === undefined) { memory = undefined; stored = 0n; m.fallback++; wrongRun = 0; }
      else {
        memory = ema(sample, memory, params);
        const next = nextRate(mode, memory, stored, params);
        const step = Number(abs(next - stored));
        m.maxNormalStepPpm = Math.max(m.maxNormalStepPpm, step);
        if (abs(next) > params.cap_ppm || mode === 'ADAPTIVE' && BigInt(step) > params.step_ppm) throw new Error('controller bound violated');
        stored = next;
        m.valid++;
        m.trackingErrorPpmSum += Number(abs(stored - target(sample)));
        const wrong = stored * sample < 0n;
        m.wrongSign += Number(wrong);
        wrongRun = wrong ? wrongRun + 1 : 0;
        m.maxWrongSignRun = Math.max(m.maxWrongSignRun, wrongRun);
      }
      epoch = Math.floor(row.at / 3600);
      appliedAt = row.at;
      m.applied++;
    }
    const nextEffective = fresh && row.at < appliedAt + 3600 ? stored : 0n;
    m.variationPpm += Number(abs(nextEffective - effective));
    m.peakPpm = Math.max(m.peakPpm, Number(abs(nextEffective)));
    if (noise) { m.noiseAbsPpmSum += Number(abs(nextEffective)); m.noiseCount++; }
    effective = nextEffective;
  }
  return m;
}

export function candidates(): Candidate[] {
  const all: Candidate[] = [{ id: 'default', params: { ...defaults } }];
  const seen = new Set([encode(defaults)]);
  for (const cap of [1000n, 2000n]) for (const step of [100n, 400n])
    for (const deadband of [0n, 200n, 500n]) for (const alpha of [250000n, 500000n, 1000000n])
      for (const smoothing of [200000n, 500000n, 1000000n]) for (const nonlinear of [1000n, 10000n]) {
        const params = { ...defaults, cap_ppm: cap, step_ppm: step, deadband_ppm: deadband,
          ema_alpha_ppm: alpha, smoothing_ppm: smoothing, nonlinear_scale_ppm: nonlinear };
        validate(params);
        if (!seen.has(encode(params))) {
          all.push({ id: `c${String(all.length).padStart(3, '0')}`, params });
          seen.add(encode(params));
        }
      }
  return all;
}

function sum(metrics: Metrics[]): Metrics {
  const result = { ...metrics[0] };
  for (const row of metrics.slice(1)) for (const key of Object.keys(result) as (keyof Metrics)[])
    result[key] = key.startsWith('max') || key === 'peakPpm' ? Math.max(result[key], row[key]) : result[key] + row[key];
  return result;
}
export function evaluate(candidate: Candidate, mode: Result['mode'], split: Result['split']): Result {
  const seeds = split === 'train' ? TRAIN_SEEDS : HOLDOUT_SEEDS;
  const metrics = SCENARIOS.flatMap(scenario => seeds.flatMap(seed => [-1, 1].map(sign =>
    measure(observations(scenario, seed, sign), mode, candidate.params, scenario === 'noise'))));
  return { id: candidate.id, mode, split, metrics: sum(metrics) };
}

// Engineering budgets declared before selection, not an economic objective or deployment approval.
export function eligible(result: Result): boolean {
  const m = result.metrics;
  return m.noiseCount > 0 && m.noiseAbsPpmSum <= 100 * m.noiseCount
    && m.maxWrongSignRun <= 5 && m.maxNormalStepPpm <= 400;
}
export function select(results: Result[]): string | null {
  const train = results.filter(r => r.mode === 'ADAPTIVE' && r.split === 'train' && eligible(r));
  train.sort((a, b) => a.metrics.trackingErrorPpmSum / a.metrics.valid - b.metrics.trackingErrorPpmSum / b.metrics.valid
    || a.metrics.variationPpm - b.metrics.variationPpm || a.id.localeCompare(b.id));
  const winner = train[0];
  if (!winner) return null;
  const holdout = results.find(r => r.id === winner.id && r.mode === 'ADAPTIVE' && r.split === 'holdout');
  return holdout && eligible(holdout) ? winner.id : null;
}
export function csv(results: Result[]): string {
  const keys = Object.keys(results[0].metrics) as (keyof Metrics)[];
  return ['id,mode,split,' + keys.join(','), ...results.map(r => [r.id, r.mode, r.split, ...keys.map(k => r.metrics[k])].join(','))].join('\n') + '\n';
}
