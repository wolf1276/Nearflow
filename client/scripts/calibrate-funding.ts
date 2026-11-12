import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALIBRATION_VERSION, TRAIN_SEEDS, HOLDOUT_SEEDS, SCENARIOS, candidates, csv, encode,
  evaluate, measure, observations, select } from '../../packages/funding/calibration';
import { ema, nextRate } from '../../packages/funding/preview';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function main() {
const args = process.argv.slice(2);
if (args.length > 1) throw new Error('Usage: npm run funding:calibrate -- [output-directory]');
const output = resolve(root, args[0] ?? 'docs/calibration');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const sourcePaths = ['packages/funding/calibration.ts', 'packages/funding/preview.ts', 'packages/funding/src/lib.rs',
  'packages/funding/traces.json', 'client/scripts/calibrate-funding.ts'];
const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(resolve(root, path), 'utf8'))])));
const grid = candidates();
const results = grid.flatMap(candidate => (['BASELINE', 'ADAPTIVE'] as const).flatMap(mode =>
  (['train', 'holdout'] as const).map(split => evaluate(candidate, mode, split))));
const selectedId = select(results);
const selected = grid.find(c => c.id === selectedId);
const inputHashes = SCENARIOS.flatMap(scenario => [...TRAIN_SEEDS, ...HOLDOUT_SEEDS].flatMap(seed => [-1, 1].map(sign =>
  ({ scenario, seed, sign, sha256: sha(encode(observations(scenario, seed, sign))) }))));
const comparisons = [grid[0], ...(selected && selected.id !== 'default' ? [selected] : [])].flatMap(candidate =>
  SCENARIOS.flatMap(scenario => (['train', 'holdout'] as const).flatMap(split =>
    (split === 'train' ? TRAIN_SEEDS : HOLDOUT_SEEDS).flatMap(seed => [-1, 1].flatMap(sign =>
      (['BASELINE', 'ADAPTIVE'] as const).map(mode => ({ id: candidate.id, scenario, split, seed, sign, mode,
        metrics: measure(observations(scenario, seed, sign), mode, candidate.params, scenario === 'noise') })))))));
const report = { version: CALIBRATION_VERSION, scope: 'CONTROLLER_ONLY_SYNTHETIC',
  provenance: { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0, sources },
  policy: { grid: `${grid.length} joint configurations, including the unchanged default`,
    selection: 'Training adaptive minimum mean absolute tracking error to raw premium clamped to 2000 ppm; then total variation; then candidate ID. Holdout only accepts/rejects the training winner, never retunes.',
    budgets: { noiseMeanAbsPpm: 100, maxWrongSignConsecutiveValidSamples: 5, maxNormalStepPpm: 400 },
    limitations: ['Exogenous prices are identical in both modes; no measured market reversion or trader response.',
      'No vault, liquidity, fees, collateral, liquidation, delta or P&L model; these metrics are not estimated.',
      'No production/default configuration change or activation. Engineering-budget winner is experimental only.'] },
  trainSeeds: TRAIN_SEEDS, holdoutSeeds: HOLDOUT_SEEDS, scenarios: SCENARIOS, candidates: grid,
  selected: selected ?? null, inputHashes, results, comparisons };
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'report.json'), JSON.stringify(JSON.parse(encode(report)), null, 2) + '\n');
await writeFile(resolve(output, 'results.csv'), csv(results));
const summaryRows = results.filter(r => r.id === 'default' || r.id === selectedId).map(r => {
  const m = r.metrics;
  return `| ${r.id} | ${r.mode} | ${r.split} | ${(m.trackingErrorPpmSum / m.valid).toFixed(3)} | ${m.variationPpm} | ${m.wrongSign} | ${m.maxWrongSignRun} | ${(m.noiseAbsPpmSum / m.noiseCount).toFixed(3)} |`;
});
await writeFile(resolve(output, 'summary.md'), [
  '# Controller-only synthetic calibration v1', '',
  `Completed sweep: ${grid.length} joint profiles, ${SCENARIOS.length} scenarios, three training and three held-out seeds, both signs and modes.`,
  `Experimental engineering-budget winner: **${selectedId ?? 'none'}**. Contract defaults remain unchanged.`, '',
  '| Profile | Mode | Split | Mean tracking error (ppm) | Total rate variation (ppm) | Wrong-sign samples | Longest wrong-sign run | Mean noise rate (absolute ppm) |',
  '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |', ...summaryRows, '',
  'Tracking target is the exogenous raw premium clamped to 2000 ppm; this is an engineering proxy, not the economically optimal funding rate.',
  'Lower tracking error can come with more rate variation and noise. Baseline has no adaptive slope limit and may beat adaptive tracking; smoothing is not assumed to be an improvement.',
  'No price response, liquidity, vault feedback, custody, liquidation, costs, delta or P&L is simulated. No live-market, closed-loop calibration or deployment claim follows.', '',
  'Full parameters, source hashes/revision/dirty state, per-seed/sign input hashes, all candidate metrics and selected/default per-scenario comparisons: [report.json](report.json).',
  'Exact aggregate metrics: [results.csv](results.csv). Replay from client/: `npm run funding:calibrate`.', '',
].join('\n'));
// Keep a small selected-profile cross-language fixture, not the entire research report in Wasm tests.
const baseTraces = JSON.parse(await readFile(resolve(root, 'packages/funding/traces.json'), 'utf8')) as Array<{ name: string; previous: number; samples: number[] }>;
const traces = selected ? baseTraces.map(trace => {
  let memory: bigint | undefined, previous = BigInt(trace.previous);
  const memories: number[] = [], rates: number[] = [];
  for (const sample of trace.samples) {
    memory = ema(BigInt(sample), memory, selected.params);
    previous = nextRate('ADAPTIVE', memory, previous, selected.params);
    memories.push(Number(memory)); rates.push(Number(previous));
  }
  return { name: `calibrated ${selected.id}: ${trace.name}`, mode: 'ADAPTIVE',
    params: Object.fromEntries(Object.entries(selected.params).map(([key, value]) => [key, Number(value)])),
    previous: trace.previous, samples: trace.samples, ema: memories, rates };
}) : [];
await writeFile(resolve(root, 'packages/funding/calibration-vectors.json'), JSON.stringify(traces, null, 2) + '\n');
console.log(`Controller-only calibration: ${grid.length} candidates, ${results.length} aggregates, ${comparisons.length} detailed comparisons.`);
console.log(`Holdout-accepted experimental profile: ${selectedId ?? 'none'}. Defaults unchanged. Report: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
