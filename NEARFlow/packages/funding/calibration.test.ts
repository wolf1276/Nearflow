import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { candidates, csv, encode, evaluate, measure, observations, SCENARIOS, select, type Result } from './calibration.ts';
import { defaults, nextRate, SCALE } from './preview.ts';

const observation = (at: number, sample: number) => ({ at, indexAt: at, markAt: at, index: 1_000_000n, mark: 1_000_000n + BigInt(sample) });

test('seeded scenarios are byte-identical across arms and have independent holdout paths', () => {
  for (const scenario of SCENARIOS) {
    assert.equal(encode(observations(scenario, 7)), encode(observations(scenario, 7)));
    assert.notEqual(encode(observations(scenario, 7)), encode(observations(scenario, 101)));
    for (const mode of ['BASELINE', 'ADAPTIVE'] as const)
      assert.deepEqual(measure(observations(scenario, 7), mode, defaults, scenario === 'noise'),
        measure(observations(scenario, 7, -1), mode, defaults, scenario === 'noise'));
  }
});

test('metrics match a hand-computed baseline trace', () => {
  const m = measure([10000, -10000, -10000, 0].map((sample, i) => observation(i * 3600 + 100, sample)), 'BASELINE', defaults);
  // EMA: 10000, 0, -5000, -2500. Rate: 2000, 0, -2000, -2000.
  assert.equal(m.trackingErrorPpmSum, 4000);
  assert.equal(m.variationPpm, 6000);
  assert.equal(m.peakPpm, 2000);
  assert.equal(m.wrongSign, 0);
  assert.equal(m.valid, 4);
});

test('replay, stale oracle and fallback follow contract cadence and EMA reset rules', () => {
  const rows = [observation(100, 10000), observation(101, -10000),
    { ...observation(3700, 10000), markAt: 3399 },
    { ...observation(7300, 10000), indexAt: 7239 }, observation(10900, -10000)];
  const m = measure(rows, 'ADAPTIVE', defaults);
  assert.equal(m.replayRejected, 1);
  assert.equal(m.fallback, 1);
  assert.equal(m.oracleRejected, 1);
  assert.equal(m.applied, 3);
  assert.equal(m.valid, 2);
  assert.equal(m.peakPpm, 400);
  assert.equal(m.trackingErrorPpmSum, 3200);
  assert.equal(m.wrongSign, 0);
});

test('joint grid is unique, bounded, symmetric and exposes quantization residual', () => {
  const grid = candidates();
  assert.equal(grid.length, 216);
  assert.equal(new Set(grid.map(c => encode(c.params))).size, grid.length);
  assert.deepEqual(grid[0].params, defaults);
  for (const candidate of grid) {
    const p = candidate.params;
    for (const mode of ['BASELINE', 'ADAPTIVE'] as const)
      assert.deepEqual(measure(observations('reversal', 41), mode, p), measure(observations('reversal', 41, -1), mode, p));
    let residual = p.cap_ppm;
    for (let i = 0; i < 128; i++) residual = nextRate('ADAPTIVE', 0n, residual, p);
    assert(residual >= 0n && residual <= (SCALE - 1n) / p.smoothing_ppm);
  }
});

test('holdout rejects the training winner instead of selecting another holdout-tuned candidate', () => {
  const base = evaluate(candidates()[0], 'ADAPTIVE', 'train');
  const metrics = { ...base.metrics, trackingErrorPpmSum: 10, maxWrongSignRun: 0, maxNormalStepPpm: 400, noiseAbsPpmSum: 0, noiseCount: 1 };
  const rows: Result[] = [
    { id: 'a', mode: 'ADAPTIVE', split: 'train', metrics },
    { id: 'b', mode: 'ADAPTIVE', split: 'train', metrics: { ...metrics, trackingErrorPpmSum: 20 } },
    { id: 'a', mode: 'ADAPTIVE', split: 'holdout', metrics: { ...metrics, noiseAbsPpmSum: 101 } },
    { id: 'b', mode: 'ADAPTIVE', split: 'holdout', metrics },
  ];
  assert.equal(select(rows), null);
  assert.equal(select(rows.map(r => r.id === 'a' && r.split === 'holdout' ? { ...r, metrics } : r)), 'a');
});

test('published artifacts match source hashes, selected profile, input hashes and recomputed checkpoints', () => {
  const root = new URL('../../', import.meta.url);
  const report = JSON.parse(readFileSync(new URL('docs/calibration/report.json', root), 'utf8'));
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  for (const [path, hash] of Object.entries(report.provenance.sources))
    assert.equal(sha(readFileSync(new URL(path, root), 'utf8')), hash, `stale calibration artifact: ${path}`);
  assert.equal(select(report.results), report.selected?.id ?? null);
  assert.equal(report.candidates.length, candidates().length);
  assert.equal(readFileSync(new URL('docs/calibration/results.csv', root), 'utf8'), csv(report.results));
  for (const input of report.inputHashes)
    assert.equal(sha(encode(observations(input.scenario, input.seed, input.sign))), input.sha256);
  for (const id of new Set(['default', report.selected?.id].filter(Boolean))) {
    const candidate = candidates().find(c => c.id === id)!;
    for (const mode of ['BASELINE', 'ADAPTIVE'] as const) for (const split of ['train', 'holdout'] as const)
      assert.deepEqual(evaluate(candidate, mode, split), report.results.find((r: Result) => r.id === id && r.mode === mode && r.split === split));
  }
});

test('CSV round-trips exact integer metrics and aggregation is deterministic', () => {
  const result = evaluate(candidates()[0], 'ADAPTIVE', 'holdout');
  assert.deepEqual(result, evaluate(candidates()[0], 'ADAPTIVE', 'holdout'));
  const [header, row] = csv([result]).trim().split('\n').map(line => line.split(','));
  assert.deepEqual(row.slice(0, 3), [result.id, result.mode, result.split]);
  for (let i = 3; i < header.length; i++) assert.equal(Number(row[i]), result.metrics[header[i] as keyof typeof result.metrics]);
  assert.throws(() => measure([observation(-1, 0)], 'ADAPTIVE', defaults), /invalid observation time/);
});
