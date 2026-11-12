import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '../../packages/funding/calibration';
import { VERSION, TRAIN, HOLDOUT, SCENARIOS, POLICY, profiles, scenario, run, type Snapshot } from '../../packages/sim/feedback';
import { aggregate, csv, decision, type Row } from '../../packages/sim/research';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
async function main() {
  if (process.argv.length > 3) throw new Error('Usage: npm run funding:feedback -- [output-directory]');
  const output = resolve(root, process.argv[2] ?? 'docs/calibration/feedback');
  const grid = profiles(), rows: Row[] = [];
  const inputs = SCENARIOS.flatMap(name => [...TRAIN, ...HOLDOUT].flatMap(seed => [-1, 1].map(sign => ({
    name, seed, sign, ticks: scenario(name, seed, sign), split: TRAIN.includes(seed) ? 'train' as const : 'holdout' as const }))));
  for (const profile of grid) for (const input of inputs) for (const sensitivity of [0n, 100000n, 1000000n])
    for (const vault of [false, true]) for (const mode of ['BASELINE', 'ADAPTIVE'] as const) rows.push({
      profile: profile.id, mode, vault, sensitivity: sensitivity.toString(), split: input.split, scenario: input.name,
      seed: input.seed, sign: input.sign, metrics: run(input.ticks, { mode, vault, sensitivity, params: profile.params }) });
  const result = decision(rows);
  const sourcePaths = ['packages/sim/ledger.ts', 'packages/sim/feedback.ts', 'packages/sim/research.ts',
    'packages/sim/accounting-vectors.json', 'packages/funding/preview.ts', 'packages/funding/calibration.ts',
    'contracts/exchange/src/math.rs', 'contracts/exchange/src/model.rs', 'contracts/exchange/src/controller.rs',
    'contracts/exchange/src/trading.rs', 'client/scripts/calibrate-feedback.ts'];
  const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(resolve(root, path), 'utf8'))])));
  const table = aggregate(rows);
  const csvText = csv(rows);
  const traces = ['default', 'c177'].flatMap(id => ['pressure', 'crash', 'partial_leg', 'spot_outage'].flatMap(name =>
    (['BASELINE', 'ADAPTIVE'] as const).flatMap(mode => [0n, 100000n, 1000000n].map(sensitivity => {
      const trace: Snapshot[] = [];
      const metrics = run(scenario(name as typeof SCENARIOS[number], HOLDOUT[0], 1),
        { mode, sensitivity, vault: true, params: grid.find(c => c.id === id)!.params }, trace);
      return { profile: id, scenario: name, mode, sensitivity, seed: HOLDOUT[0], sign: 1, metrics, trace };
    }))));
  const report = { version: VERSION, scope: 'MODEL_PAPER_MARKET_VAULT_FEEDBACK', hours: 32, runs: rows.length,
    provenance: { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0, sources },
    profiles: grid, trainSeeds: TRAIN, holdoutSeeds: HOLDOUT, sensitivitiesPpm: [0, 100000, 1000000], policy: POLICY,
    model: { oracleIntervalSec: 30, decisionIntervalSec: 3600, bookRetentionPpm: 800000, fullDepthImpactPpm: 2000,
      perpLeverage: 10, maintenanceBps: 500, perpEntryFeeBps: 3, spotFeeAndSlippageBps: 20,
      vaults: 2, initialPerpCashPerVaultAtoms: '5000000000', initialSpotCashPerVaultAtoms: '5000000000',
      selection: 'Per identical-input training case, no regression versus default BASELINE in premium/peak, vault net P&L, worst drawdown, cost, unresolved exposure, liquidation count or rate variation. Require some strict premium improvement. Rank eligible profiles by total training premium; holdout only accepts/rejects the training winner.',
      limitations: ['Stylized hourly matched-lot/depth model; no real order queue or live liquidity fit.',
        'Two PAPER long-spot/short-perp strategies; not the runtime Guardian/adapters or contract trading authority.',
        'Intra-hour index constant, oracle checkpoints every 30 sec, risk/policy checks hourly; sub-hour finality/queue dynamics unmodeled.',
        'Capped bilateral P&L/funding and independent spot custody; no insurance bailout or OI-skew equation.',
        'Response/depth/impact/cost assumptions are sensitivity experiments, not empirically fitted estimates.',
        'Strict no-regression rule is a research filter, not approved owner policy or a claim that joint dominance is necessary for economic value.'] },
    inputs: inputs.map(i => ({ scenario: i.name, seed: i.seed, sign: i.sign, split: i.split, sha256: sha(encode(i.ticks)) })),
    decision: result, csvSha256: sha(csvText), aggregates: table };
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'report.json'), encode(report) + '\n');
  await writeFile(resolve(output, 'runs.csv'), csvText);
  await writeFile(resolve(output, 'traces.json'), encode(traces) + '\n');
  const summary = ['# Market / PAPER-vault feedback calibration v1', '',
    `${rows.length} deterministic runs; ${grid.length} joint profiles, ${SCENARIOS.length} scenarios, 3 training + 3 independent holdout seeds, both demand signs, zero/weak/strong funding responsiveness, baseline/adaptive and vault off/on.`, '',
    `Training winner: **${result.trainWinner ?? 'none'}**. Holdout-accepted profile: **${result.selected ?? 'none'}**. Contract defaults and real authority remain unchanged.`, '',
    '| Profile | Mode | Vault | Response ppm | Holdout mean absolute book premium ppm | Mean vault net P&L (quote atoms) | Worst drawdown (quote atoms) | Cost/run (quote atoms) | Residual-delta breach hours |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const id of ['default', 'c177']) for (const mode of ['BASELINE', 'ADAPTIVE'] as const) for (const vault of [false, true])
    for (const sensitivity of ['0', '100000', '1000000']) {
      const subset = rows.filter(r => r.profile === id && r.mode === mode && r.vault === vault && r.sensitivity === sensitivity && r.split === 'holdout');
      const count = BigInt(subset.length);
      const sum = (key: 'premiumAbsPpm' | 'vaultNetPnl' | 'costs') => subset.reduce((total, r) => total + r.metrics[key], 0n);
      const drawdown = subset.reduce((maximum, r) => r.metrics.maxDrawdown > maximum ? r.metrics.maxDrawdown : maximum, 0n);
      summary.push(`| ${id} | ${mode} | ${vault ? 'on' : 'off'} | ${sensitivity} | ${sum('premiumAbsPpm') / (32n * count)} | ${sum('vaultNetPnl') / count} | ${drawdown} | ${sum('costs') / count} | ${subset.reduce((total, r) => total + r.metrics.breachHours, 0)} |`);
    }
  summary.push('', 'Money/base atoms use 1e6 scale. Mean P&L includes marked residual inventory; it is not settled withdrawable profit. Positive carry can lose money during a crash when the perp gain cap binds. Spot outages/counterparty exits leave visible unresolved exposure; retries stop rather than silently restoring a hedge.', '',
    'All measured negative/no-improvement cases are retained. Default baseline is the fixed reference; default and candidate same-profile baseline/adaptive ablations are also included.',
    'This completes the specified local-model calibration, not live-market validation or the runtime automation release gate. No claim of profitability, robustness outside these assumptions, production calibration or deployment approval.', '',
    'Reproduce from client/: `npm run funding:feedback`. [Full provenance, assumptions, parameters, rejection reasons and scenario aggregates](report.json); [every run](runs.csv); [failure/decision replay traces](traces.json).', '');
  await writeFile(resolve(output, 'summary.md'), summary.join('\n'));
  console.log(`${rows.length} feedback runs, ${table.length} scenario aggregates; selected=${result.selected ?? 'none'}. Output: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
