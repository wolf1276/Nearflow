import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { defaults } from '../funding/preview';
import { encode } from '../funding/calibration';
import { PerpLedger, SpotLedger, PRICE, UNIT, settlement, payout, type Pair } from './ledger';
import { run, scenario, profiles, SCENARIOS, type Snapshot, type Metrics } from './feedback';
import { aggregate, csv, decision, type Row } from './research';

function ledger() {
  const p = new PerpLedger();
  for (const id of ['alice', 'bob', 'keeper']) p.add(id, 1000n * UNIT);
  p.publish(100n * PRICE, 0); return p;
}
test('shared PAPER accounting vectors match signed rounding, payer caps and bilateral payout', () => {
  const vectors = JSON.parse(readFileSync(new URL('./accounting-vectors.json', import.meta.url), 'utf8'));
  for (const v of vectors) {
    const p: Pair = { id: 0, long: 'alice', short: 'bob', opened: 0, size: BigInt(v.size), entry: BigInt(v.entry),
      longMargin: BigInt(v.longMargin), shortMargin: BigInt(v.shortMargin), checkpoint: BigInt(v.checkpoint), remainder: BigInt(v.remainder) };
    const result = settlement(p, BigInt(v.index));
    assert.equal(result.payment, BigInt(v.payment)); assert.equal(result.remainder, BigInt(v.nextRemainder));
    p.longMargin -= result.payment; p.shortMargin += result.payment;
    const value = payout(p, BigInt(v.price));
    assert.equal(value.long, BigInt(v.longPayout)); assert.equal(value.short, BigInt(v.shortPayout));
  }
});
test('closed-form oracle stream equals actual checkpoint truncation for both rate signs and expiry', () => {
  for (const rate of [-2000n, 0n, 2000n]) for (const appliedAt of [0, 3600]) {
    const fast = ledger(), slow = ledger();
    for (const p of [fast, slow]) { p.applyRate(rate, 0); p.publish(101n * PRICE, appliedAt); }
    fast.oracleStream(119);
    for (let n = 1; n <= 119; n++) slow.publish(101n * PRICE, appliedAt + n * 30);
    assert.equal(fast.index, slow.index); assert.equal(fast.updatedAt, slow.updatedAt); assert.equal(fast.oracleAt, slow.oracleAt);
    const expected = appliedAt === 0 ? (101n * PRICE * rate * 30n / (UNIT * 3600n)) * 119n
      : 100n * PRICE * rate * 60n / (UNIT * 3600n);
    assert.equal(fast.index, expected);
  }
});
test('PAPER custody survives partial close, rate reversal, liquidation and duplicate close rejection', () => {
  const p = ledger();
  const lot = p.match('alice', 'bob', UNIT, 100n * PRICE, 0)!;
  p.applyRate(2000n, 0); p.oracleStream(119); p.accrue(3600); p.settle(lot);
  const before = p.account('alice').funding;
  p.settle(lot); assert.equal(p.account('alice').funding, before);
  p.close(lot, false, UNIT / 3n); p.audit();
  p.publish(100n * PRICE, 3600); p.applyRate(-2000n, 3600); p.oracleStream(119); p.accrue(7200);
  p.publish(200n * PRICE, 7200); p.close(lot, true); p.audit();
  assert.equal(p.liquidations, 1); assert(p.cappedPnl > 0);
  assert.throws(() => p.close(lot), /invalid close/);
});
test('spot inventory/cash are separate from perp collateral and fees are not free money', () => {
  const s = new SpotLedger(), p = ledger();
  s.add('venue', 10000n * UNIT, 100n * UNIT); s.add('vault', 1000n * UNIT);
  const custody = p.custody;
  assert(s.trade('vault', true, UNIT, 100n * PRICE));
  assert.equal(s.account('vault').cash, 899800000n);
  assert(s.trade('vault', false, UNIT, 100n * PRICE));
  assert.equal(s.account('vault').cash, 999600000n);
  assert.equal(s.account('vault').realized, -400000n); assert.equal(s.account('vault').costs, 400000n);
  s.audit(); p.audit(); assert.equal(p.custody, custody);
  assert.equal(s.trade('vault', false, UNIT, 100n * PRICE), false);
});
test('identical seeded inputs replay exactly and disabling responsiveness/vault isolates controller impact', () => {
  const ticks = scenario('pressure', 17, 1);
  assert.equal(encode(ticks), encode(scenario('pressure', 17, 1)));
  assert.notEqual(encode(ticks), encode(scenario('pressure', 701, 1)));
  const options = { mode: 'ADAPTIVE' as const, params: defaults, vault: true, sensitivity: 100000n };
  assert.deepEqual(run(ticks, options), run(ticks, options));
  const a = run(ticks, { ...options, mode: 'BASELINE', vault: false, sensitivity: 0n });
  const b = run(ticks, { ...options, vault: false, sensitivity: 0n });
  assert.equal(a.premiumAbsPpm, b.premiumAbsPpm);
  assert.equal(a.vaultNetPnl, 0n); assert.equal(b.vaultNetPnl, 0n);
  assert.equal(a.custodyChecks, 33);
});
test('all failure scenarios/modes/sensitivities preserve custody, accounting identity and equal matched OI', () => {
  for (const name of SCENARIOS) for (const mode of ['BASELINE', 'ADAPTIVE'] as const) for (const sensitivity of [0n, 100000n, 1000000n]) {
    const trace: Snapshot[] = [];
    const m = run(scenario(name, 29, 1), { mode, params: defaults, vault: true, sensitivity }, trace);
    assert.equal(m.vaultNetPnl, m.realizedPnl + m.unrealizedPnl);
    assert(m.costs >= 0n); assert(m.policyChecks > 0); assert.equal(m.custodyChecks, 33);
    for (const s of trace) assert.equal(s.longOi, s.shortOi);
  }
});
test('model contains allowed/declined hedges, partial legs, failed-venue residuals, counterparty exits and capped crash losses', () => {
  const options = { mode: 'BASELINE' as const, params: defaults, vault: true, sensitivity: 0n };
  const normal = run(scenario('pressure', 17, 1), options);
  assert(normal.accepted > 0); assert(normal.skipped > 0); assert(normal.costs > 0n);
  const partial = run(scenario('partial_leg', 17, 1), options);
  assert(partial.failedLegs > 0); assert(partial.pendingHours > 0); assert(partial.breachHours > 0);
  const down = run(scenario('spot_outage', 17, 1), options);
  assert(down.paused > 0); assert(down.counterpartyCloses > 0); assert(down.maxDeltaAfterStep > 0n);
  const crash = run(scenario('crash', 17, 1), options);
  assert(crash.liquidations > 0); assert(crash.capBindingObservations > 0); assert(crash.maxDrawdown > 0n);
  assert(crash.vaultNetPnl < 0n); assert.equal(crash.minMarginRatioPpm, 0n);
});
test('feedback selection uses identical-input references and never retunes on holdout failure', () => {
  const metrics = run(scenario('pressure', 17, 1, 1), { mode: 'BASELINE', params: defaults, vault: false, sensitivity: 0n });
  const base: Row = { profile: 'default', mode: 'BASELINE', vault: false, sensitivity: '0', scenario: 'pressure', seed: 17, sign: 1, split: 'train', metrics };
  const rows: Row[] = [base, { ...base, split: 'holdout' }];
  for (const profile of ['a', 'b']) for (const split of ['train', 'holdout'] as const)
    rows.push({ ...base, profile, mode: 'ADAPTIVE', split, metrics: { ...metrics,
      premiumAbsPpm: metrics.premiumAbsPpm - (profile === 'a' ? 2n : 1n), costs: profile === 'a' && split === 'holdout' ? 1n : 0n } });
  assert.equal(decision(rows).trainWinner, 'a'); assert.equal(decision(rows).selected, null);
  assert.equal(decision(rows.filter(r => r.split !== 'holdout' || r.profile !== 'a')).selected, null);
  assert.throws(() => decision([...rows, base]), /duplicate baseline/);
  assert.throws(() => decision(rows.filter(r => r.mode !== 'BASELINE')), /missing identical-input baseline/);
});
test('feedback report sources, inputs, every CSV metric, aggregates and replay traces are reproducible', () => {
  const root = new URL('../../', import.meta.url);
  const report = JSON.parse(readFileSync(new URL('docs/calibration/feedback/report.json', root), 'utf8'));
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  for (const [path, hash] of Object.entries(report.provenance.sources))
    assert.equal(sha(readFileSync(new URL(path, root), 'utf8')), hash, `stale feedback artifact: ${path}`);
  for (const input of report.inputs)
    assert.equal(sha(encode(scenario(input.scenario, input.seed, input.sign))), input.sha256);
  const text = readFileSync(new URL('docs/calibration/feedback/runs.csv', root), 'utf8');
  assert.equal(sha(text), report.csvSha256);
  const [header, ...lines] = text.trim().split('\n').map(line => line.split(','));
  const template = run(scenario('pressure', 17, 1, 1), { mode: 'BASELINE', params: defaults, vault: false, sensitivity: 0n });
  const rows: Row[] = lines.map(fields => {
    const metrics = Object.fromEntries(header.slice(8).map((key, i) => [key,
      typeof template[key as keyof Metrics] === 'bigint' ? BigInt(fields[i + 8]) : Number(fields[i + 8])])) as unknown as Metrics;
    return { profile: fields[0], mode: fields[1] as Row['mode'], vault: fields[2] === '1', sensitivity: fields[3],
      split: fields[4] as Row['split'], scenario: fields[5], seed: Number(fields[6]), sign: Number(fields[7]), metrics };
  });
  assert.equal(rows.length, report.runs); assert.equal(rows.length, 30240);
  assert.equal(csv(rows), text);
  assert.equal(encode(aggregate(rows)), JSON.stringify(report.aggregates));
  assert.equal(encode(decision(rows)), JSON.stringify(report.decision));
  for (const row of [rows[0], rows[321], rows[rows.length - 1]])
    assert.equal(encode(run(scenario(row.scenario as typeof SCENARIOS[number], row.seed, row.sign), {
      mode: row.mode, vault: row.vault, sensitivity: BigInt(row.sensitivity), params: profiles().find(p => p.id === row.profile)!.params })), encode(row.metrics));
  const traces = JSON.parse(readFileSync(new URL('docs/calibration/feedback/traces.json', root), 'utf8'));
  for (const example of traces) {
    const trace: Snapshot[] = [];
    const metrics = run(scenario(example.scenario, example.seed, example.sign), {
      mode: example.mode, vault: true, sensitivity: BigInt(example.sensitivity), params: profiles().find(p => p.id === example.profile)!.params }, trace);
    assert.equal(encode(trace), JSON.stringify(example.trace)); assert.equal(encode(metrics), JSON.stringify(example.metrics));
  }
});
test('shortlist is joint, bounded and default-preserving; invalid simulation inputs fail', () => {
  assert.equal(profiles().length, 15); assert.deepEqual(profiles()[0].params, defaults);
  assert.throws(() => scenario('pressure', 1, 0), /invalid scenario/);
  assert.throws(() => run([], { mode: 'BASELINE', params: defaults, vault: true, sensitivity: 0n }), /empty/);
  const tick = scenario('pressure', 1, 1)[0];
  assert.throws(() => run([{ ...tick, depth: 0n }], { mode: 'BASELINE', params: defaults, vault: true, sensitivity: 0n }), /invalid tick/);
});
