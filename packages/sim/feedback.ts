import { defaults, ema, nextRate, premium, validate, type Params } from '../funding/preview';
import { candidates } from '../funding/calibration';
import { PerpLedger, SpotLedger, PRICE, UNIT, abs, clamp, min, notional, fee, payout } from './ledger';

export const VERSION = 1;
export const TRAIN = [17, 29, 61];
export const HOLDOUT = [701, 911, 1409];
export const SCENARIOS = ['noise', 'pressure', 'impulse', 'reversal', 'crash', 'sparse', 'low_depth', 'oracle_gap', 'keeper_gap', 'spot_outage', 'partial_leg', 'counterparty_exit', 'manipulation', 'bursts'] as const;
export type Scenario = typeof SCENARIOS[number];
export const POLICY = { horizon: 8, persistence: 2, cooldown: 2, maxHold: 8, maxRetries: 2,
  maxGross: 500n * UNIT, reserve: 200n * UNIT, maxDelta: UNIT / 4n,
  dailyCosts: 2n * UNIT, dailyTurnover: 2000n * UNIT, entryPpm: 1000n, gas: 10000n };
export interface Tick { hour: number; index: bigint; spot: bigint; shock: bigint; depth: bigint;
  oracle: boolean; keeper: boolean; spotAvailable: boolean; partial: boolean; counterpartyExit: boolean; manipulate: boolean; organic: boolean; probe: boolean; burst: boolean }
export function scenario(name: Scenario, seed: number, sign: number, hours = 32): Tick[] {
  if (!SCENARIOS.includes(name) || !Number.isSafeInteger(seed) || ![-1, 1].includes(sign) || !Number.isSafeInteger(hours) || hours < 1 || hours > 96) throw new Error('invalid scenario');
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  return Array.from({ length: hours }, (_, hour) => {
    const noise = BigInt(Number(random() % 501) - 250);
    const index = (100n + BigInt(sign) * (name === 'crash' && hour >= 9 ? -45n : BigInt(Number(random() % 3) - 1))) * PRICE;
    const direction = name === 'reversal' && hour >= 16 ? -1n : 1n;
    const shock = BigInt(sign) * (name === 'noise' || name === 'reversal' && hour >= 24 ? noise
      : name === 'impulse' ? (hour === 8 ? 20000n : noise) : direction * 1500n + noise);
    return { hour, index, spot: index * (UNIT + (name === 'spot_outage' && hour >= 8 && hour <= 12 ? 5000n : noise)) / UNIT,
      shock, depth: name === 'low_depth' ? UNIT / 5n : (3n + BigInt(random() % 3)) * UNIT,
      oracle: !(name === 'oracle_gap' && hour >= 7 && hour <= 11),
      keeper: !(name === 'keeper_gap' && hour >= 7 && hour <= 11),
      spotAvailable: !(name === 'spot_outage' && hour >= 8 && hour <= 12), partial: name === 'partial_leg',
      counterpartyExit: (name === 'counterparty_exit' || name === 'spot_outage') && hour === 9,
      manipulate: name === 'manipulation' && (hour === 5 || hour === 17), organic: name !== 'sparse' || hour % 4 === 0,
      probe: name === 'impulse' && hour === 8 || name === 'reversal' && hour === 23, burst: name === 'bursts' };
  });
}
export function profiles() {
  const all = [{ id: 'default', params: { ...defaults } }, { id: 'c177', params: candidates().find(c => c.id === 'c177')!.params }];
  const key = (p: Params) => JSON.stringify(p, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  const seen = new Set(all.map(c => key(c.params)));
  for (const alpha of [250000n, 500000n, 1000000n]) for (const smoothing of [200000n, 500000n]) for (const deadband of [0n, 200n]) {
    const params = { ...defaults, ema_alpha_ppm: alpha, smoothing_ppm: smoothing, deadband_ppm: deadband };
    if (!seen.has(key(params))) { all.push({ id: `f${all.length}`, params }); seen.add(key(params)); }
  }
  for (const cap of [1000n, 2000n]) all.push({ id: `f${all.length}`, params: { ...defaults, cap_ppm: cap, step_ppm: 100n } });
  return all;
}
export interface Metrics {
  premiumAbsPpm: bigint; peakPremiumPpm: bigint; rateVariationPpm: bigint; peakRatePpm: bigint; rateSignChanges: number;
  vaultNetPnl: bigint; realizedPnl: bigint; unrealizedPnl: bigint; realizedFunding: bigint; costs: bigint;
  maxDrawdown: bigint; maxDelta: bigint; maxDeltaAfterStep: bigint; deltaBaseHours: bigint; breachHours: number;
  repairCosts: bigint; capBindingObservations: number; liquidations: number; counterpartyCloses: number;
  accepted: number; skipped: number; paused: number; fallbacks: number; failedLegs: number; pendingHours: number;
  policyChecks: number; custodyChecks: number; finalSpot: bigint; finalPerp: bigint; minMarginRatioPpm: bigint;
  reversionProbes: number; reversionSteps: number; unreverted: number;
}
export interface RunOptions { mode: 'BASELINE' | 'ADAPTIVE'; params: Params; vault: boolean; sensitivity: bigint }
interface Vault { id: string; streak: number; last: number; paused: boolean; retries: number; pendingUntil: number;
  day: number; spent: bigint; turnover: bigint; peak: bigint; partialInjected: boolean }
export interface Snapshot { hour: number; rate: bigint; premium: bigint; longOi: bigint; shortOi: bigint; vaultEquity: bigint; delta: bigint; decision: string }

/** Matched-lot PAPER experiment, not the runtime Guardian or an executable venue adapter. */
export function run(ticks: Tick[], options: RunOptions, trace?: Snapshot[]): Metrics {
  validate(options.params);
  if (![0n, 100000n, 1000000n].includes(options.sensitivity) || options.params.oracle_max_age_sec !== 60n) throw new Error('unsupported experiment assumptions');
  const perp = new PerpLedger(), spot = new SpotLedger();
  for (const id of ['longs', 'shorts', 'adversary', 'keeper', 'operator']) perp.add(id, 1_000_000n * UNIT);
  spot.add('venue', 1_000_000n * UNIT, 1000n * UNIT);
  const vaults: Vault[] = ['v0', 'v1'].map(id => {
    perp.add(id, 5000n * UNIT); spot.add(id, 5000n * UNIT);
    return { id, streak: 0, last: -100, paused: false, retries: 0, pendingUntil: -1, day: -1,
      spent: 0n, turnover: 0n, peak: 10000n * UNIT, partialInjected: false };
  });
  const m: Metrics = { premiumAbsPpm: 0n, peakPremiumPpm: 0n, rateVariationPpm: 0n, peakRatePpm: 0n, rateSignChanges: 0,
    vaultNetPnl: 0n, realizedPnl: 0n, unrealizedPnl: 0n, realizedFunding: 0n, costs: 0n, maxDrawdown: 0n,
    maxDelta: 0n, maxDeltaAfterStep: 0n, deltaBaseHours: 0n, breachHours: 0, repairCosts: 0n, capBindingObservations: 0,
    liquidations: 0, counterpartyCloses: 0, accepted: 0, skipped: 0, paused: 0, fallbacks: 0, failedLegs: 0, pendingHours: 0,
    policyChecks: 0, custodyChecks: 0, finalSpot: 0n, finalPerp: 0n, minMarginRatioPpm: 100n * UNIT,
    reversionProbes: 0, reversionSteps: 0, unreverted: 0 };
  let book = 0n, memory: bigint | undefined, mark: { price: bigint; at: number } | undefined, previousRate = 0n;
  let lastTick: Tick | undefined, reversionStart: number | undefined;
  let lastNonzeroRate = 0n;
  const shortSize = (id: string) => perp.pairs.filter(p => p.short === id).reduce((s, p) => s + p.size, 0n);
  const delta = (id: string) => spot.account(id).base - shortSize(id);
  const equity = (id: string, price: bigint) => perp.equity(id) + spot.account(id).cash + notional(spot.account(id).base, price);
  const markDelta = (id: string) => { m.maxDelta = m.maxDelta > abs(delta(id)) ? m.maxDelta : abs(delta(id)); };
  const pause = (v: Vault) => { if (!v.paused) m.paused++; v.paused = true; };
  const gas = (v: Vault) => {
    if (perp.account(v.id).cash < POLICY.gas) throw new Error('unreserved action cost');
    perp.account(v.id).cash -= POLICY.gas; perp.account('operator').cash += POLICY.gas;
    perp.account(v.id).fees += POLICY.gas; v.spent += POLICY.gas;
  };
  for (const tick of ticks) {
    if (!Number.isSafeInteger(tick.hour) || tick.hour < 0 || tick.depth <= 0n || tick.index <= 0n || tick.spot <= 0n) throw new Error('invalid tick');
    const now = tick.hour * 3600;
    if (lastTick && tick.hour !== lastTick.hour + 1) throw new Error('non-consecutive scenario');
    lastTick = tick;
    perp.accrue(now);
    if (tick.oracle) perp.publish(tick.index, now);
    const fresh = perp.fresh(now);
    let depth = tick.depth;
    book = clamp(book * 800000n / UNIT + tick.shock, -49000n, 49000n);
    const price = () => perp.price * (UNIT + book) / UNIT;
    const fill = (long: string, short: string, wanted: bigint, direction: bigint, injectPartial = false) => {
      if (!fresh) return 0n;
      const size = min(injectPartial ? wanted / 2n : wanted, depth);
      const p = perp.match(long, short, size, price(), tick.hour);
      if (!p) return 0n;
      depth -= size; mark = { price: p.entry, at: now };
      book = clamp(book + direction * size * 2000n / tick.depth, -49000n, 49000n);
      return size;
    };
    if (fresh) {
      for (const p of [...perp.pairs]) {
        perp.settle(p);
        const health = payout(p, perp.price);
        const maintenance = notional(p.size, perp.price) * 500n / 10000n || 1n;
        m.minMarginRatioPpm = min(m.minMarginRatioPpm, min(health.long, health.short) * UNIT / maintenance);
        const risk = perp.risk(p);
        if (risk.long || risk.short) perp.close(p, true);
        else if ((p.long === 'longs' && p.short === 'shorts' && tick.hour - p.opened >= 3)
          || p.long === 'adversary' && tick.hour - p.opened >= 1) perp.close(p);
        else if (tick.counterpartyExit && p.short.startsWith('v')) { perp.close(p); m.counterpartyCloses++; }
      }
    }
    if (tick.organic) {
      fill('longs', 'shorts', min(UNIT / 2n, depth / 4n), tick.shock >= 0n ? 1n : -1n);
      if (tick.burst) {
        fill('longs', 'shorts', min(UNIT / 10n, depth), 1n);
        fill('longs', 'shorts', min(UNIT / 10n, depth), -1n);
      }
      if (tick.manipulate && fresh) {
        const manipulated = perp.price * 1049000n / UNIT;
        const p = perp.match('adversary', 'shorts', UNIT / 50n, manipulated, tick.hour);
        if (p) mark = { price: manipulated, at: now };
      }
    }
    if (tick.keeper && fresh) {
      let sample: bigint | undefined;
      if (mark) try { sample = premium(perp.price, mark.price, BigInt(perp.oracleAt), BigInt(mark.at), BigInt(now), options.params); } catch { /* invalid mark => zero fallback */ }
      if (sample === undefined) { memory = undefined; perp.applyRate(0n, now); m.fallbacks++; }
      else { memory = ema(sample, memory, options.params); perp.applyRate(nextRate(options.mode, memory, perp.rate, options.params), now); }
    }
    const effective = fresh && now < perp.appliedAt + 3600 ? perp.rate : 0n;
    if (abs(effective) > options.params.cap_ppm) throw new Error('rate cap');
    m.rateVariationPpm += abs(effective - previousRate);
    if (effective * lastNonzeroRate < 0n) m.rateSignChanges++;
    if (effective !== 0n) lastNonzeroRate = effective;
    previousRate = effective;
    m.peakRatePpm = m.peakRatePpm > abs(effective) ? m.peakRatePpm : abs(effective);
    // Aggressor pressure, never long-minus-short OI. Only executed lots affect the next mark.
    const response = clamp(effective * options.sensitivity * tick.depth / (1000n * UNIT), -depth / 2n, depth / 2n);
    if (response !== 0n) fill('longs', 'shorts', abs(response), response > 0n ? -1n : 1n);
    let decision = 'vault_disabled';
    for (const v of options.vault ? vaults : []) {
      m.policyChecks++;
      if (v.day !== Math.floor(tick.hour / 24)) { v.day = Math.floor(tick.hour / 24); v.spent = 0n; v.turnover = 0n; }
      const s = spot.account(v.id), a = perp.account(v.id);
      const budget = (cost: bigint, turnover: bigint) => {
        m.policyChecks++;
        return cost >= 0n && v.spent + cost <= POLICY.dailyCosts && v.turnover + turnover <= POLICY.dailyTurnover && a.cash >= POLICY.reserve;
      };
      const sell = (size: bigint, repair: boolean) => {
        const value = notional(size, tick.spot), estimated = (value * 20n + 9999n) / 10000n + POLICY.gas;
        if (!tick.spotAvailable || !budget(estimated, value) || !spot.trade(v.id, false, size, tick.spot)) return false;
        gas(v); v.spent += estimated - POLICY.gas; v.turnover += value;
        if (repair) m.repairCosts += estimated;
        return true;
      };
      const close = () => {
        if (!fresh) return false;
        const pairs = perp.pairs.filter(p => p.short === v.id);
        const turnover = pairs.reduce((total, p) => total + notional(p.size, perp.price), 0n);
        if (!budget(POLICY.gas * BigInt(pairs.length), turnover)) return false;
        for (const p of pairs) { perp.close(p); gas(v); }
        v.turnover += turnover;
        return true;
      };
      if (v.pendingUntil > tick.hour) { m.pendingHours++; decision = 'pending_reconciliation'; continue; }
      if (abs(delta(v.id)) > 0n) {
        decision = 'repair_residual';
        const before = abs(delta(v.id));
        if (v.retries >= POLICY.maxRetries || delta(v.id) < 0n || !sell(delta(v.id), true)) { v.retries++; pause(v); }
        else { v.retries = 0; v.last = tick.hour; }
        if (before > POLICY.maxDelta) pause(v);
        if (abs(delta(v.id)) > 0n) { m.skipped++; continue; }
      }
      const open = perp.pairs.filter(p => p.short === v.id);
      if (open.length) {
        if (!fresh || !tick.spotAvailable) { decision = 'paused_stale_or_venue'; pause(v); m.skipped++; continue; }
        if (v.paused || effective <= 0n || tick.hour - open[0].opened >= POLICY.maxHold) {
          decision = 'bounded_unwind';
          if (!close() || !sell(s.base, true)) pause(v);
          v.last = tick.hour;
        } else decision = 'hedged';
        continue;
      }
      v.streak = effective >= POLICY.entryPpm ? v.streak + 1 : 0;
      if (v.paused || !fresh || !tick.spotAvailable || v.streak < POLICY.persistence || tick.hour - v.last < POLICY.cooldown) { m.skipped++; decision = 'entry_policy_skip'; continue; }
      const size = min(UNIT, depth), value = notional(size, price());
      const spotValue = notional(size, tick.spot);
      // Eight-hour uncertain horizon; payer margin cap; both-leg costs, exit/repair/basis reserves.
      const collectible = min(value * effective * BigInt(POLICY.horizon) / UNIT, (value + 9n) / 10n);
      const projectedCosts = (spotValue * 40n + 9999n) / 10000n + fee(value) + value * 30n / 10000n + POLICY.gas * 4n;
      const actualEntry = (spotValue * 20n + 9999n) / 10000n + fee(value) + POLICY.gas * 2n;
      const requiredMargin = (value + 9n) / 10n;
      if (value < UNIT || value + spotValue > POLICY.maxGross || collectible <= projectedCosts || s.cash < spotValue + actualEntry
        || a.cash < POLICY.reserve + requiredMargin + fee(value) + POLICY.gas * 2n || !budget(projectedCosts, value + spotValue)) {
        m.skipped++; decision = 'negative_net_carry_or_budget'; continue;
      }
      const feesBefore = a.fees + s.costs, spentBefore = v.spent, entryPrice = price();
      if (!spot.trade(v.id, true, size, tick.spot)) { m.skipped++; continue; }
      gas(v); markDelta(v.id);
      const partial = tick.partial && !v.partialInjected;
      const filled = fill('longs', v.id, size, -1n, partial);
      if (filled > 0n) gas(v);
      v.spent = spentBefore + a.fees + s.costs - feesBefore;
      v.turnover += spotValue + notional(filled, entryPrice); v.last = tick.hour;
      if (filled !== size) { m.failedLegs++; m.pendingHours++; v.partialInjected = true; v.pendingUntil = tick.hour + 1; decision = 'partial_pending'; }
      else decision = 'open_hedge';
      m.accepted++;
    }
    if (tick.probe) { reversionStart = tick.hour; m.reversionProbes++; }
    if (reversionStart !== undefined && tick.hour > reversionStart && abs(book) <= 500n) {
      m.reversionSteps += tick.hour - reversionStart; reversionStart = undefined;
    }
    m.premiumAbsPpm += abs(book); m.peakPremiumPpm = m.peakPremiumPpm > abs(book) ? m.peakPremiumPpm : abs(book);
    for (const v of vaults) {
      markDelta(v.id);
      const net = abs(delta(v.id));
      m.maxDeltaAfterStep = m.maxDeltaAfterStep > net ? m.maxDeltaAfterStep : net;
      m.deltaBaseHours += net;
      if (net > POLICY.maxDelta) m.breachHours++;
      const value = equity(v.id, tick.spot);
      v.peak = v.peak > value ? v.peak : value;
      m.maxDrawdown = m.maxDrawdown > v.peak - value ? m.maxDrawdown : v.peak - value;
    }
    for (const p of perp.pairs) {
      const raw = p.size * (perp.price - p.entry) / PRICE;
      if (raw < -p.longMargin || raw > p.shortMargin) m.capBindingObservations++;
      const value = p.longMargin + clamp(raw, -p.longMargin, p.shortMargin);
      const shortValue = p.shortMargin - clamp(raw, -p.longMargin, p.shortMargin);
      const maintenance = notional(p.size, perp.price) * 500n / 10000n || 1n;
      const ratio = min(value, shortValue) * UNIT / maintenance;
      m.minMarginRatioPpm = min(m.minMarginRatioPpm, ratio);
    }
    perp.audit(); spot.audit(); m.custodyChecks++;
    const oi = perp.pairs.reduce((total, p) => total + p.size, 0n);
    trace?.push({ hour: tick.hour, rate: effective, premium: book, longOi: oi, shortOi: oi,
      vaultEquity: vaults.reduce((total, v) => total + equity(v.id, tick.spot), 0n), delta: vaults.reduce((total, v) => total + delta(v.id), 0n), decision });
    if (tick.oracle) perp.oracleStream(119);
  }
  if (!lastTick) throw new Error('empty scenario');
  if (reversionStart !== undefined) { m.unreverted++; m.reversionSteps += lastTick.hour - reversionStart; }
  perp.accrue((lastTick.hour + 1) * 3600);
  if (perp.fresh((lastTick.hour + 1) * 3600)) for (const p of perp.pairs) perp.settle(p);
  for (const v of vaults) {
    const a = perp.account(v.id), s = spot.account(v.id);
    const net = equity(v.id, lastTick.spot) - 10000n * UNIT;
    const realized = a.pnl + a.funding - a.fees + s.realized;
    m.vaultNetPnl += net; m.realizedPnl += realized; m.unrealizedPnl += net - realized;
    m.realizedFunding += a.funding; m.costs += a.fees + s.costs;
    m.finalSpot += s.base; m.finalPerp += shortSize(v.id);
  }
  m.liquidations = perp.liquidations; m.capBindingObservations += perp.cappedPnl + perp.cappedFunding;
  perp.audit(); spot.audit(); m.custodyChecks++;
  return m;
}
