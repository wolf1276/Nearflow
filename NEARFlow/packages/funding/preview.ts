// Preview only: authoritative configuration, signals and applied rate live on-chain.
export const SCALE = 1_000_000n;
export interface Params {
  version: number; cap_ppm: bigint; step_ppm: bigint; deadband_ppm: bigint;
  smoothing_ppm: bigint; ema_alpha_ppm: bigint; nonlinear_scale_ppm: bigint;
  max_premium_ppm: bigint; oracle_max_age_sec: bigint; mark_max_age_sec: bigint;
}
export const defaults: Params = {
  version: 1, cap_ppm: 2000n, step_ppm: 400n, deadband_ppm: 200n,
  smoothing_ppm: 200000n, ema_alpha_ppm: 500000n, nonlinear_scale_ppm: 10000n,
  max_premium_ppm: 100000n, oracle_max_age_sec: 60n, mark_max_age_sec: 300n,
};
const abs = (x: bigint) => x < 0n ? -x : x;
const clamp = (x: bigint, lo: bigint, hi: bigint) => x < lo ? lo : x > hi ? hi : x;
const within = (x: bigint, lo: bigint, hi: bigint) => x >= lo && x <= hi;
export function validate(p: Params) {
  if (p.version !== 1 || !within(p.cap_ppm, 1n, 2000n) || !within(p.step_ppm, 1n, p.cap_ppm)
    || !within(p.deadband_ppm, 0n, 2000n) || !within(p.smoothing_ppm, 1n, SCALE)
    || !within(p.ema_alpha_ppm, 1n, SCALE) || !within(p.nonlinear_scale_ppm, 1000n, 100000n)
    || !within(p.max_premium_ppm, 2000n, 100000n) || p.deadband_ppm >= p.max_premium_ppm
    || !within(p.oracle_max_age_sec, 1n, 60n) || !within(p.mark_max_age_sec, 1n, 300n))
    throw new Error('invalid parameters');
}
export function nextRate(mode: 'BASELINE' | 'ADAPTIVE', premium: bigint, previous: bigint, p = defaults) {
  validate(p);
  if (abs(premium) > p.max_premium_ppm || abs(previous) > p.cap_ppm) throw new Error('signal outside bounds');
  if (mode === 'BASELINE') return clamp(premium, -p.cap_ppm, p.cap_ppm);
  if (mode !== 'ADAPTIVE') throw new Error('unknown mode');
  const magnitude = abs(premium) > p.deadband_ppm ? abs(premium) - p.deadband_ppm : 0n;
  const effective = premium < 0n ? -magnitude : magnitude;
  const target = clamp(effective + effective * magnitude / p.nonlinear_scale_ppm, -p.cap_ppm, p.cap_ppm);
  const smoothed = previous + (target - previous) * p.smoothing_ppm / SCALE;
  return clamp(clamp(smoothed, previous - p.step_ppm, previous + p.step_ppm), -p.cap_ppm, p.cap_ppm);
}
export function premium(index: bigint, mark: bigint, indexAt: bigint, markAt: bigint, now: bigint, p = defaults) {
  validate(p);
  const maxPrice = 10n ** 27n;
  if (index <= 0n || mark <= 0n || index > maxPrice || mark > maxPrice || indexAt < 0n || markAt < 0n
    || now < indexAt || now < markAt || now - indexAt > p.oracle_max_age_sec || now - markAt > p.mark_max_age_sec)
    throw new Error('invalid or stale signal');
  const sample = (mark - index) * SCALE / index;
  if (abs(sample) > p.max_premium_ppm) throw new Error('premium outside bounds');
  return sample;
}
export function ema(sample: bigint, previous: bigint | undefined, p = defaults) {
  validate(p);
  if (abs(sample) > p.max_premium_ppm || (previous !== undefined && abs(previous) > p.max_premium_ppm))
    throw new Error('signal outside bounds');
  return previous === undefined ? sample : previous + (sample - previous) * p.ema_alpha_ppm / SCALE;
}
