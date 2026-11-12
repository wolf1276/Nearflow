// Internal PAPER custody only. Prices 1e18; base and quote atoms 1e6, matching the exchange.
export const PRICE = 10n ** 18n;
export const UNIT = 10n ** 6n;
export const abs = (v: bigint) => v < 0n ? -v : v;
export const min = (a: bigint, b: bigint) => a < b ? a : b;
export const clamp = (v: bigint, lo: bigint, hi: bigint) => v < lo ? lo : v > hi ? hi : v;
export const notional = (size: bigint, price: bigint) => size * price / PRICE;
export const fee = (quote: bigint) => (quote * 3n + 9999n) / 10000n;
export interface Account { cash: bigint; funding: bigint; pnl: bigint; fees: bigint }
export interface Pair {
  id: number; long: string; short: string; size: bigint; entry: bigint;
  longMargin: bigint; shortMargin: bigint; checkpoint: bigint; remainder: bigint; opened: number;
}
export function settlement(p: Pair, index: bigint) {
  const numerator = p.size * (index - p.checkpoint) + p.remainder;
  const owed = numerator / PRICE;
  const payment = clamp(owed, -p.shortMargin, p.longMargin);
  return { payment, remainder: payment === owed ? numerator % PRICE : 0n };
}
export function payout(p: Pair, price: bigint) {
  const raw = p.size * (price - p.entry) / PRICE;
  const pnl = clamp(raw, -p.longMargin, p.shortMargin);
  return { long: p.longMargin + pnl, short: p.shortMargin - pnl, pnl, capped: raw !== pnl };
}
export class PerpLedger {
  accounts = new Map<string, Account>();
  pairs: Pair[] = [];
  insurance = 0n;
  custody = 0n;
  index = 0n;
  rate = 0n;
  appliedAt = 0;
  price = 100n * PRICE;
  oracleAt = 0;
  updatedAt = 0;
  nextId = 0;
  liquidations = 0;
  cappedFunding = 0;
  cappedPnl = 0;
  add(id: string, cash: bigint) {
    if (cash < 0n || this.accounts.has(id)) throw new Error('invalid PAPER account');
    this.accounts.set(id, { cash, funding: 0n, pnl: 0n, fees: 0n }); this.custody += cash;
  }
  account(id: string) { const a = this.accounts.get(id); if (!a) throw new Error('unknown PAPER account'); return a; }
  fresh(now: number, ttl = 60) { return this.price > 0n && this.oracleAt <= now && now - this.oracleAt <= ttl; }
  accrue(now: number, ttl = 60) {
    if (now < this.updatedAt) throw new Error('time regression');
    const end = Math.min(now, this.oracleAt + ttl, this.appliedAt + 3600);
    const elapsed = Math.max(0, end - this.updatedAt);
    this.index += this.price * this.rate * BigInt(elapsed) / (UNIT * 3600n);
    this.updatedAt = now;
  }
  publish(price: bigint, now: number, ttl = 60) {
    if (price <= 0n || price > 10n ** 27n || now < this.oracleAt) throw new Error('invalid oracle');
    this.accrue(now, ttl); this.price = price; this.oracleAt = now;
  }
  // Exact reduction of equal-price 30-second oracle checkpoints; upgrade if intra-hour prices are modeled.
  oracleStream(ticks: number, ttl = 60) {
    if (ttl < 30 || this.updatedAt !== this.oracleAt || this.updatedAt % 30 || this.appliedAt % 30 || ticks < 0 || !Number.isSafeInteger(ticks)) throw new Error('invalid stream partition');
    const active = Math.max(0, Math.min(ticks, Math.floor((this.appliedAt + 3600 - this.updatedAt) / 30)));
    this.index += this.price * this.rate * 30n / (UNIT * 3600n) * BigInt(active);
    this.updatedAt += ticks * 30; this.oracleAt = this.updatedAt;
  }
  applyRate(rate: bigint, now: number) { this.accrue(now); this.rate = rate; this.appliedAt = now; }
  match(long: string, short: string, size: bigint, entry: bigint, hour: number): Pair | undefined {
    if (long === short || size <= 0n || entry < this.price * 95n / 100n || entry > this.price * 105n / 100n) return;
    const quote = notional(size, entry);
    const margin = (quote + 9n) / 10n, cost = fee(quote);
    if (quote < UNIT || this.pairs.length >= 256 || this.pairs.reduce((s, p) => s + p.size, 0n) + size > 1000n * UNIT) return;
    for (const owner of [long, short]) if (this.account(owner).cash < margin + cost || this.pairs.filter(p => p.long === owner || p.short === owner).length >= 32) return;
    for (const owner of [long, short]) {
      const a = this.account(owner); a.cash -= margin + cost; a.fees += cost; this.insurance += cost;
    }
    const p: Pair = { id: this.nextId++, long, short, size, entry, longMargin: margin, shortMargin: margin,
      checkpoint: this.index, remainder: 0n, opened: hour };
    this.pairs.push(p); return p;
  }
  settle(p: Pair) {
    const { payment, remainder } = settlement(p, this.index);
    const owed = (p.size * (this.index - p.checkpoint) + p.remainder) / PRICE;
    if (payment !== owed) this.cappedFunding++;
    p.longMargin -= payment; p.shortMargin += payment;
    this.account(p.long).funding -= payment; this.account(p.short).funding += payment;
    p.remainder = remainder; p.checkpoint = this.index;
  }
  risk(p: Pair) {
    const value = payout(p, this.price);
    const maintenance = notional(p.size, this.price) * 500n / 10000n || 1n;
    return { long: value.long <= maintenance, short: value.short <= maintenance };
  }
  close(p: Pair, liquidation = false, size = p.size) {
    if (!this.pairs.includes(p) || size <= 0n || size > p.size) throw new Error('invalid close');
    this.settle(p);
    const risk = this.risk(p);
    if (liquidation && (!(risk.long || risk.short) || size !== p.size)) throw new Error('healthy liquidation');
    const part = { ...p, size, longMargin: p.longMargin * size / p.size, shortMargin: p.shortMargin * size / p.size };
    const value = payout(part, this.price);
    if (value.capped) this.cappedPnl++;
    let long = value.long, short = value.short;
    if (liquidation) {
      const penalty = min(risk.long ? long : short, notional(size, this.price) * 50n / 10000n);
      if (risk.long) long -= penalty; else short -= penalty;
      const reward = penalty / 2n;
      this.account('keeper').cash += reward; this.insurance += penalty - reward;
      this.account(risk.long ? p.long : p.short).fees += penalty;
      this.liquidations++;
    }
    this.account(p.long).cash += long; this.account(p.short).cash += short;
    this.account(p.long).pnl += value.pnl; this.account(p.short).pnl -= value.pnl;
    if (size === p.size) this.pairs = this.pairs.filter(other => other !== p);
    else {
      p.remainder = p.remainder * (p.size - size) / p.size;
      p.size -= size; p.longMargin -= part.longMargin; p.shortMargin -= part.shortMargin;
    }
  }
  equity(id: string) {
    return this.pairs.reduce((total, p) => {
      if (p.long !== id && p.short !== id) return total;
      const { payment } = settlement(p, this.index);
      const value = payout({ ...p, longMargin: p.longMargin - payment, shortMargin: p.shortMargin + payment }, this.price);
      return total + (p.long === id ? value.long : value.short);
    }, this.account(id).cash);
  }
  audit() {
    const cash = [...this.accounts.values()].reduce((s, a) => { if (a.cash < 0n) throw new Error('negative collateral'); return s + a.cash; }, 0n);
    const margins = this.pairs.reduce((s, p) => { if (p.longMargin < 0n || p.shortMargin < 0n || p.size <= 0n || abs(p.remainder) >= PRICE) throw new Error('invalid pair'); return s + p.longMargin + p.shortMargin; }, 0n);
    if (cash + margins + this.insurance !== this.custody) throw new Error('PAPER perp conservation');
    if ([...this.accounts.values()].reduce((s, a) => s + a.funding, 0n) !== 0n) throw new Error('non-zero-sum funding');
  }
}

export interface SpotAccount { cash: bigint; base: bigint; basis: bigint; realized: bigint; costs: bigint }
export class SpotLedger {
  accounts = new Map<string, SpotAccount>();
  cashTotal = 0n;
  baseTotal = 0n;
  add(id: string, cash: bigint, base = 0n) {
    if (cash < 0n || base < 0n || this.accounts.has(id)) throw new Error('invalid PAPER spot account');
    this.accounts.set(id, { cash, base, basis: 0n, realized: 0n, costs: 0n }); this.cashTotal += cash; this.baseTotal += base;
  }
  account(id: string) { const a = this.accounts.get(id); if (!a) throw new Error('unknown spot account'); return a; }
  trade(id: string, buy: boolean, size: bigint, price: bigint, costBps = 20n) {
    if (size <= 0n || price <= 0n || costBps < 0n || costBps >= 10000n) throw new Error('invalid spot trade');
    const a = this.account(id), venue = this.account('venue');
    const quote = notional(size, price), cost = (quote * costBps + 9999n) / 10000n;
    if (buy) {
      if (a.cash < quote + cost || venue.base < size) return false;
      a.cash -= quote + cost; venue.cash += quote + cost; a.base += size; venue.base -= size; a.basis += quote + cost;
    } else {
      if (a.base < size || venue.cash < quote - cost) return false;
      const basis = a.basis * size / a.base;
      a.base -= size; venue.base += size; a.cash += quote - cost; venue.cash -= quote - cost;
      a.basis -= basis; a.realized += quote - cost - basis;
    }
    a.costs += cost; return true;
  }
  audit() {
    let cash = 0n, base = 0n;
    for (const a of this.accounts.values()) { if (a.cash < 0n || a.base < 0n || a.basis < 0n) throw new Error('negative spot custody'); cash += a.cash; base += a.base; }
    if (cash !== this.cashTotal || base !== this.baseTotal) throw new Error('PAPER spot conservation');
  }
}
