import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaults, ema, nextRate, premium } from './preview.ts';

test('shared Rust/TypeScript rate vectors', () => {
  const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
  for (const v of vectors) assert.equal(nextRate(v.mode, BigInt(v.premium), BigInt(v.previous)), BigInt(v.rate));
});
test('shared stateful traces and sign mirrors cover noise, reversal and coefficient extremes', () => {
  const traces = ['./traces.json', './calibration-vectors.json'].flatMap(path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')));
  for (const trace of traces) {
    const params = { ...defaults, ...Object.fromEntries(Object.entries(trace.params).map(([key, value]) =>
      [key, key === 'version' ? Number(value) : BigInt(value as number)])) };
    for (const sign of [-1n, 1n]) {
      let previous = BigInt(trace.previous) * sign;
      let memory: bigint | undefined;
      for (let i = 0; i < trace.samples.length; i++) {
        memory = ema(BigInt(trace.samples[i]) * sign, memory, params);
        assert.equal(memory, BigInt(trace.ema[i]) * sign, trace.name);
        const next = nextRate(trace.mode, memory, previous, params);
        assert.equal(next, BigInt(trace.rates[i]) * sign, trace.name);
        assert(next >= -params.cap_ppm && next <= params.cap_ppm);
        if (trace.mode === 'ADAPTIVE') assert(next - previous >= -params.step_ppm && next - previous <= params.step_ppm);
        previous = next;
      }
    }
  }
});
test('signal validation and EMA', () => {
  assert.equal(premium(100000n, 100120n, 100n, 100n, 101n), 1200n);
  assert.equal(premium(100000n, 99880n, 100n, 100n, 101n), -1200n);
  assert.equal(ema(1000n, undefined), 1000n);
  assert.equal(ema(-1000n, 1000n), 0n);
  assert.throws(() => premium(0n, 1n, 0n, 0n, 0n));
  assert.throws(() => premium(100n, 100n, 0n, 0n, 61n));
  assert.throws(() => premium(1n, 10n ** 27n, 1n, 1n, 1n));
  assert.throws(() => premium(100n, 100n, 2n, 2n, 1n));
  assert.throws(() => premium(100n, 100n, 400n, 1n, 400n));
  assert.throws(() => nextRate('ADAPTIVE', -(2n ** 63n), 0n));
  assert.throws(() => nextRate('ADAPTIVE', 0n, 0n, { ...defaults, smoothing_ppm: 2n ** 63n }));
});
test('bounded symmetric adaptive rate across valid inputs', () => {
  for (let p = -100000n; p <= 100000n; p += 997n) {
    for (let previous = -2000n; previous <= 2000n; previous += 211n) {
      const r = nextRate('ADAPTIVE', p, previous);
      assert(r >= -2000n && r <= 2000n && r - previous >= -400n && r - previous <= 400n);
      assert.equal(r, -nextRate('ADAPTIVE', -p, -previous));
    }
  }
});
