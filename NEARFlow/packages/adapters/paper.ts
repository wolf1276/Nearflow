import { Store, hash } from "../vault/store";
import { abs, fresh, value, type Adapter, type Fill, type Leg, type Observation, type OrderRequest, type Quote, type Status } from "./types";

interface PaperState {
  version: 1; strategy: string; leg: Leg; cash: bigint; position: bigint; margin: bigint;
  entryValue: bigint; payerCollateral: bigint; realizedPnl: bigint; funding: bigint;
  costs: bigint; capBinding: boolean; quote: Quote; orders: Record<string, Fill>;
}
export class PaperAdapter implements Adapter {
  readonly mode = "PAPER" as const;
  constructor(readonly leg: Leg, readonly store: Store<PaperState>) {}
  async initialize(strategy: string, cash: bigint, quote: Quote, payerCollateral = 0n) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(strategy) || quote.leg !== this.leg || !fresh(quote, quote.at) || cash < 0n || payerCollateral < 0n) throw Error("Invalid PAPER initialization");
    await this.store.transaction(async old => {
      if (old) throw Error("PAPER ledger already initialized");
      return { state: { version: 1, strategy, leg: this.leg, cash, position: 0n, margin: 0n, entryValue: 0n, payerCollateral, realizedPnl: 0n, funding: 0n, costs: 0n, capBinding: false, quote, orders: {} }, result: undefined };
    });
  }
  private async state() {
    const s = await this.store.load();
    if (!s || s.version !== 1 || s.leg !== this.leg) throw Error("Missing or mismatched PAPER ledger");
    return s;
  }
  private executableQuote(s: PaperState): Quote {
    const used = Object.values(s.orders).filter(o => o.request.quote.id === s.quote.id).reduce((n, o) => n + o.filled, 0n);
    return { ...s.quote, depth: s.quote.depth > used ? s.quote.depth - used : 0n };
  }
  async quote(_now: number) { return this.executableQuote(await this.state()); }
  async marketView() {
    const s = await this.state();
    return { mode: this.mode, leg: this.leg, market: s.quote.market, quote: this.executableQuote(s), position: s.position,
      fills: Object.values(s.orders).filter(o => o.filled > 0n).map(o => ({ id: o.id, side: o.request.side, size: o.filled, price: o.request.quote.price })) };
  }
  async observe(now: number): Promise<Observation> {
    const s = await this.state();
    const marked = value(abs(s.position), s.quote.price);
    const raw = this.leg === "perp" ? s.entryValue - marked : marked - s.entryValue;
    const pnl = this.leg === "spot" ? raw : raw < -s.margin ? -s.margin : raw > s.payerCollateral ? s.payerCollateral : raw;
    return { mode: this.mode, leg: this.leg, strategy: s.strategy, at: now, available: s.quote.available, oracleFresh: fresh(s.quote, now), position: s.position, cash: s.cash, margin: s.margin, payerCollateral: s.payerCollateral, realizedPnl: s.realizedPnl, unrealizedPnl: pnl, equity: this.leg === "perp" ? s.margin + pnl : marked, funding: s.funding, costs: s.costs, capBinding: s.capBinding || pnl !== raw };
  }
  async lookup(id: string) { const s = await this.state(); return Object.hasOwn(s.orders, id) ? s.orders[id] : null; }
  async submit(r: OrderRequest, now: number): Promise<Fill> {
    return this.store.transaction(async s => {
      if (!s || s.leg !== this.leg || r.leg !== this.leg || r.strategy !== s.strategy || !/^[a-zA-Z0-9_:/-]{1,160}$/.test(r.id) || !r.id.startsWith(`${r.strategy}/`) || r.size <= 0n) throw Error("Invalid PAPER order");
      const existing = s.orders[r.id];
      if (existing) {
        if (hash(existing.request) !== hash(r)) throw Error("Conflicting client ID");
        return { state: s, result: existing };
      }
      if (Object.keys(s.orders).length >= 2048) throw Error("PAPER order archive required");
      const marginBps = r.marginBps ?? 1000n;
      const valid = fresh(r.quote, now) && hash(r.quote) === hash(this.executableQuote(s)) && marginBps >= 1000n && marginBps <= 10_000n && r.size <= r.quote.depth;
      const f: Fill = { id: r.id, request: r, revision: 0, status: valid ? "pending" : "rejected", filled: 0n, costs: 0n, reason: valid ? "awaiting PAPER fill" : "expired/unavailable/conflicting quote", receipt: null };
      s.orders[r.id] = f;
      return { state: s, result: f };
    });
  }
  async cancel(id: string): Promise<Fill> {
    return this.store.transaction(async s => {
      const f = s?.orders[id];
      if (!s || !Object.hasOwn(s.orders, id) || !f) throw Error("Unknown PAPER order");
      if (f.status === "pending" || f.status === "partial") { f.status = "cancelled"; f.revision++; f.reason = "cancelled"; }
      return { state: s, result: f };
    });
  }
  // Explicit deterministic fixture driver, never a public or real venue endpoint.
  async fill(id: string, cumulative: bigint, now: number, terminal: Status = "partial"): Promise<Fill> {
    return this.store.transaction(async s => {
      const f = s?.orders[id];
      if (!s || !Object.hasOwn(s.orders, id) || !f || !["pending", "partial"].includes(f.status)) throw Error("Order not pending");
      if (cumulative < f.filled || cumulative > f.request.size || !fresh(s.quote, now) || !fresh(f.request.quote, now) || hash(s.quote) !== hash({ ...f.request.quote, depth: s.quote.depth })) throw Error("Invalid or stale PAPER fill");
      const amount = cumulative - f.filled;
      if (amount === 0n) return { state: s, result: f };
      const q = f.request.quote;
      const depthUsed = Object.values(s.orders).filter(o => o.request.quote.id === q.id).reduce((n, o) => n + o.filled, 0n);
      if (depthUsed + amount > s.quote.depth) throw Error("PAPER depth depleted");
      const nominal = value(amount, q.price);
      const costs = (value(cumulative, q.price) * (q.feeBps + q.slippageBps) + 9999n) / 10_000n - f.costs;
      const signed = f.request.side === "buy" ? amount : -amount;
      if (this.leg === "spot") {
        if (s.position + signed < 0n || (f.request.reduceOnly && signed > 0n)) throw Error("Spot inventory/reduce constraint");
        const debit = signed > 0n ? nominal + costs : costs - nominal;
        if (s.cash < debit) throw Error("Insufficient PAPER spot cash");
        if (signed > 0n) s.entryValue += nominal;
        else {
          const basis = s.entryValue * amount / s.position;
          s.entryValue -= basis; s.realizedPnl += nominal - basis;
        }
        s.cash -= debit; s.position += signed;
      } else if (signed < 0n && !f.request.reduceOnly) {
        const margin = (nominal * (f.request.marginBps ?? 1000n) + 9999n) / 10_000n;
        if (s.cash < margin + costs) throw Error("Insufficient PAPER margin");
        s.cash -= margin + costs; s.margin += margin; s.position += signed; s.entryValue += nominal;
      } else {
        if (!f.request.reduceOnly || signed < 0n || amount > abs(s.position)) throw Error("Perp reduce constraint");
        const before = abs(s.position);
        if (before === 0n && amount > 0n) throw Error("No perp position");
        if (amount > 0n) {
          const entry = s.entryValue * amount / before;
          const margin = s.margin * amount / before;
          const raw = entry - nominal;
          const pnl = raw < -margin ? -margin : raw > s.payerCollateral ? s.payerCollateral : raw;
          if (s.cash + margin + pnl < costs) throw Error("Insufficient PAPER exit costs");
          s.cash += margin + pnl - costs; s.margin -= margin; s.entryValue -= entry;
          s.payerCollateral -= pnl; s.realizedPnl += pnl; s.position += signed; s.capBinding ||= raw !== pnl;
        }
      }
      s.costs += costs; f.costs += costs; f.filled = cumulative; f.revision++;
      f.status = cumulative === f.request.size ? "filled" : terminal;
      if (f.status === "filled" && cumulative !== f.request.size) throw Error("Incomplete terminal fill");
      f.reason = "PAPER fixture reconciliation";
      return { state: s, result: f };
    });
  }
  async market(quote: Quote) {
    if (quote.leg !== this.leg || quote.mode !== this.mode || !fresh({ ...quote, available: true }, quote.at)) throw Error("Invalid quote");
    await this.store.transaction(async s => { if (!s) throw Error("Missing PAPER ledger"); if (quote.market !== s.quote.market) throw Error("PAPER market immutable"); s.quote = quote; return { state: s, result: undefined }; });
  }
  async funding(paymentToShort: bigint) {
    if (this.leg !== "perp") throw Error("Spot has no perp funding");
    await this.store.transaction(async s => {
      if (!s || s.position === 0n) throw Error("No PAPER perp position");
      const paid = paymentToShort < -s.margin ? -s.margin : paymentToShort > s.payerCollateral ? s.payerCollateral : paymentToShort;
      s.margin += paid; s.payerCollateral -= paid; s.funding += paid;
      return { state: s, result: undefined };
    });
  }
  async counterpartyClose(now: number) {
    const s = await this.state();
    if (this.leg !== "perp" || s.position === 0n) throw Error("No PAPER perp position");
    // Normal bounded settlement, not a fabricated liquidation or chain receipt.
    const id = `${s.strategy}/external/${Object.keys(s.orders).length}`;
    await this.submit({ id, strategy: s.strategy, leg: this.leg, side: "buy", size: abs(s.position), quote: this.executableQuote(s), reduceOnly: true }, now);
    return this.fill(id, abs(s.position), now);
  }
}
