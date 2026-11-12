import { abs, fresh, value, type Adapter, type Fill, type Leg, type Observation, type OrderRequest } from "../../packages/adapters/types";
import { ownerOnly, policyHash, type Policy } from "../../packages/risk/policy";
import { transition, type State } from "../../packages/risk/state-machine";
import { watchdog } from "../../packages/risk/watchdog";
import { type Opportunity } from "../../packages/vault/opportunity";
import { sizeHedge } from "../../packages/vault/sizing";
import { appendEvent, replay, type DecisionEvent } from "../../packages/vault/events";
import { hash, Store } from "../../packages/vault/store";

interface Intent { request: OrderRequest; sent: boolean; fill: Fill | null; }
export interface Journal {
  version: 1; policy: Policy; policyHash: string; state: State; stopped: boolean;
  epoch: number; configRevision: number; lastAction: number | null; clock: number;
  day: number; turnover: bigint; costs: bigint; reservedCosts: bigint; retries: number;
  deltaSince: number | null; intents: Intent[]; events: DecisionEvent[];
  observations: { spot: Observation; perp: Observation } | null;
  funding: { ppm: bigint; expires: number } | null;
}
export class Guardian {
  constructor(readonly store: Store<Journal>, readonly spot: Adapter, readonly perp: Adapter) {
    if (spot.mode !== "PAPER" || perp.mode !== "PAPER" || spot.leg !== "spot" || perp.leg !== "perp") throw Error("PAPER-only Guardian: real/mixed adapters disabled");
  }
  async create(policy: Policy, actor: string) {
    ownerOnly(policy, actor);
    const digest = policyHash(policy);
    await this.store.transaction(async old => {
      if (old) throw Error("Policy immutable; create a new strategy/revision");
      const s: Journal = { version: 1, policy, policyHash: digest, state: "draft", stopped: false, epoch: -1, configRevision: 0, lastAction: null, clock: 0, day: 0, turnover: 0n, costs: 0n, reservedCosts: 0n, retries: 0, deltaSince: null, intents: [], events: [], observations: null, funding: null };
      this.event(s, 0, "confirm", "owner-confirmed PAPER policy", policy, null);
      return { state: s, result: undefined };
    });
  }
  private checked(s: Journal | null, now: number): Journal {
    if (!s || s.version !== 1 || policyHash(s.policy) !== s.policyHash) throw Error("Missing/tampered policy");
    if (!Number.isSafeInteger(now) || now < s.clock) throw Error("Invalid/reversed clock");
    replay(s.events); s.clock = now;
    const day = Math.floor(now / 86_400);
    if (day > s.day) { s.day = day; s.turnover = 0n; }
    return s;
  }
  private event(s: Journal, now: number, kind: string, reason: string, input: unknown, result: unknown) {
    appendEvent(s.events, { strategy: s.policy.strategy, mode: "PAPER", policyHash: s.policyHash, policyRevision: s.policy.revision, epoch: s.epoch, configRevision: s.configRevision, at: now, kind, reason, input, result });
  }
  private pauseState(s: Journal, now: number, reason: string) {
    s.state = transition(s.state, "paused"); s.stopped = true;
    this.event(s, now, "pause", reason, null, null);
  }
  private adapter(leg: Leg) { return leg === "spot" ? this.spot : this.perp; }
  private pending(s: Journal) { return s.intents.some(i => i.sent && (!i.fill || ["pending", "partial"].includes(i.fill.status))); }
  async snapshot() { const s = await this.store.load(); return this.checked(s, s?.clock ?? 0); }
  async propose(o: Opportunity, now: number) {
    const observed = { spot: await this.spot.observe(now), perp: await this.perp.observe(now) };
    return this.store.transaction(async old => {
      const s = this.checked(old, now), p = s.policy;
      let reason = "";
      if (observed.spot.strategy !== p.strategy || observed.perp.strategy !== p.strategy) throw Error("Adapter strategy mismatch");
      if (s.stopped || !["draft", "quoting"].includes(s.state)) reason = "strategy stopped/not ready";
      else if (o.epoch <= s.epoch) reason = "epoch replay";
      else if (s.lastAction !== null && now - s.lastAction < p.cooldownSeconds) reason = "cooldown";
      else if (observed.spot.position !== 0n || observed.perp.position !== 0n || this.pending(s)) reason = "existing exposure/pending orders";
      const effective = { ...o, requestedSize: o.size, spotCash: observed.spot.cash, perpCash: observed.perp.cash, payerCollateral: observed.perp.payerCollateral };
      const sized = sizeHedge(p, effective, now);
      effective.size = sized.size;
      const e = sized.evaluation;
      if (!reason && !e.allowed) reason = e.reason;
      if (!reason && (e.gross + s.turnover > p.maxDailyTurnover || e.costs + s.costs > p.maxTotalCost || effective.size > p.maxDelta)) reason = "turnover/cost/transient delta limit";
      if (o.epoch > s.epoch && Number.isSafeInteger(o.epoch)) { s.epoch = o.epoch; s.configRevision = o.configRevision; }
      if (reason) { this.event(s, now, "skip", reason, effective, e); return { state: s, result: false }; }
      s.state = transition(transition(s.state, "quoting"), "opening");
      s.reservedCosts = e.costs; s.observations = observed;
      s.funding = { ppm: o.fundingPpm, expires: Math.min(o.spot.expires, o.perp.expires, o.fundingExpiresAt ?? now + 3600) };
      s.intents = (["spot", "perp"] as const).map(leg => ({ request: { id: `${p.strategy}/${s.epoch}/open/${leg}`, strategy: p.strategy, leg, side: leg === "spot" ? "buy" : "sell", size: effective.size, quote: o[leg], reduceOnly: false, marginBps: p.minMarginBps }, sent: false, fill: null }));
      this.event(s, now, "proposal", e.reason, effective, e);
      return { state: s, result: true };
    });
  }
  async dispatch(id: string, now: number) {
    const current = await this.snapshot();
    const intent = current.intents.find(i => i.request.id === id);
    if (!intent) throw Error("Unknown intent");
    // Sent is durable BEFORE submission. Unknown outcomes are looked up, never retried blindly.
    if (intent.sent) return this.reconcile(now);
    const q = await this.adapter(intent.request.leg).quote(now);
    const request = await this.store.transaction(async old => {
      const s = this.checked(old, now);
      const i = s.intents.find(i => i.request.id === id)!;
      if (i.sent) return { state: s, result: null };
      if ((s.stopped && s.state !== "unwinding") || !["opening", "repairing", "unwinding"].includes(s.state)) throw Error("Strategy stopped");
      if (!fresh(q, now) || hash(q) !== hash(i.request.quote)) {
        this.pauseState(s, now, "quote changed/expired before submission"); return { state: s, result: null };
      }
      if (!i.request.reduceOnly && (!s.funding || now >= s.funding.expires)) {
        this.pauseState(s, now, "funding observation expired before submission"); return { state: s, result: null };
      }
      i.sent = true; s.lastAction = now;
      this.event(s, now, "execute", "submission intent persisted; receipt unknown", i.request, null);
      return { state: s, result: i.request };
    });
    if (request) {
      try { await this.adapter(request.leg).submit(request, now); }
      catch { /* Reconcile venue by stable ID; no exception text/secrets in audit. */ }
    }
    await this.reconcile(now);
  }
  async reconcile(now: number, fundingPpm?: bigint) {
    const snapshot = await this.snapshot();
    const fills = await Promise.all(snapshot.intents.map(i => i.sent ? this.adapter(i.request.leg).lookup(i.request.id) : null));
    const observations = { spot: await this.spot.observe(now), perp: await this.perp.observe(now) };
    const quotes = { spot: await this.spot.quote(now), perp: await this.perp.quote(now) };
    await this.store.transaction(async old => {
      const s = this.checked(old, now);
      if (hash(s.intents) !== hash(snapshot.intents)) throw Error("Concurrent reconciliation; retry reads only");
      const expected = { spot: s.observations?.spot.position ?? 0n, perp: s.observations?.perp.position ?? 0n };
      for (let n = 0; n < s.intents.length; n++) {
        const i = s.intents[n], f = fills[n];
        if (!i.sent) continue;
        if (!f) { if (s.state !== "settled") this.pauseState(s, now, "unknown receipt; no blind resubmission"); continue; }
        if (hash(f.request) !== hash(i.request) || f.id !== i.request.id || f.filled < 0n || f.filled > i.request.size || f.costs < 0n || !Number.isSafeInteger(f.revision) || f.revision < 0 || !["pending", "partial", "filled", "rejected", "cancelled"].includes(f.status) || f.receipt !== null || (f.status === "filled" && f.filled !== i.request.size)) {
          this.pauseState(s, now, "conflicting venue state"); continue;
        }
        if (i.fill && (f.revision < i.fill.revision || f.filled < i.fill.filled || f.costs < i.fill.costs || (f.revision === i.fill.revision && hash(f) !== hash(i.fill)) || (!["pending", "partial"].includes(i.fill.status) && hash(f) !== hash(i.fill)))) {
          this.pauseState(s, now, "out-of-order/conflicting fill revision"); continue;
        }
        if (hash(f) === hash(i.fill)) continue;
        const delta = f.filled - (i.fill?.filled ?? 0n);
        expected[i.request.leg] += i.request.side === "buy" ? delta : -delta;
        s.costs += f.costs - (i.fill?.costs ?? 0n);
        s.turnover += value(delta, i.request.quote.price);
        i.fill = f;
        this.event(s, now, "receipt", "reconciled cumulative PAPER fill", i.request, f);
      }
      if (observations.spot.position !== expected.spot || observations.perp.position !== expected.perp) {
        const reductionsOnly = observations.spot.position >= 0n && observations.spot.position <= expected.spot && observations.perp.position <= 0n && observations.perp.position >= expected.perp;
        this.event(s, now, "external-change", reductionsOnly ? "venue/counterparty reduced exposure; reconcile residual hedge" : "unexplained exposure change; stop", { expected, observations }, null);
        if (!reductionsOnly && s.state !== "settled") this.pauseState(s, now, "unexplained venue exposure");
        else if (reductionsOnly && !s.stopped && ["hedged", "opening"].includes(s.state)) s.state = transition(s.state, "repairing");
      }
      if (observations.spot.strategy !== s.policy.strategy || observations.perp.strategy !== s.policy.strategy) throw Error("Adapter strategy mismatch");
      const observedCosts = observations.spot.costs + observations.perp.costs;
      if (observedCosts < s.costs) this.pauseState(s, now, "conflicting venue cost state");
      else s.costs = observedCosts;
      s.observations = observations;
      const watch = watchdog(s.policy, observations.spot, observations.perp, quotes.perp, fundingPpm ?? (s.funding && now < s.funding.expires ? s.funding.ppm : 0n), now, s.deltaSince);
      s.deltaSince = watch.deltaSince;
      const depthLost = (["spot", "perp"] as const).some(leg => abs(observations[leg].position) * 10_000n > quotes[leg].depth * s.policy.maxParticipationBps);
      const divergent = quotes.spot.market !== quotes.perp.market || abs(quotes.spot.price - quotes.perp.price) * 10_000n > (quotes.spot.price < quotes.perp.price ? quotes.spot.price : quotes.perp.price) * 300n;
      const reason = s.costs > s.policy.maxTotalCost || s.turnover > s.policy.maxDailyTurnover ? "execution budget exhausted" : watch.reason ?? (depthLost ? "exit liquidity depleted" : divergent ? "spot/perp observation divergence" : null);
      if (s.state !== "settled") {
        if (reason) this.pauseState(s, now, reason);
        else if (s.state === "unwinding" && !this.pending(s) && observations.spot.position === 0n && observations.perp.position === 0n) s.state = transition(s.state, "settled");
        else if (["opening", "repairing"].includes(s.state) && !this.pending(s) && s.intents.every(i => i.sent && i.fill?.status === "filled") && watch.delta === 0n) s.state = observations.spot.position === 0n && observations.perp.position === 0n
          ? transition(transition(s.state, "unwinding"), "settled") : transition(s.state, "hedged");
        else if (s.intents.some(i => i.fill?.status === "rejected" || i.fill?.status === "cancelled") && s.state !== "paused") this.pauseState(s, now, "leg failed/cancelled; residual exposure visible");
      }
      if (s.state === "settled") s.stopped = true;
      this.event(s, now, "observe", reason ?? "reconciled independent legs", observations, watch);
      return { state: s, result: undefined };
    });
  }
  async pause(actor: string, now: number, reason = "owner stop; pending orders retained") {
    await this.store.transaction(async old => { const s = this.checked(old, now); ownerOnly(s.policy, actor); this.pauseState(s, now, reason); return { state: s, result: undefined }; });
  }
  async refreshFunding(observation: { epoch: number; revision: number; ppm: bigint; expires: number }, now: number) {
    await this.store.transaction(async old => {
      const s = this.checked(old, now);
      if (observation.epoch !== s.epoch || observation.revision !== s.configRevision || !Number.isSafeInteger(observation.expires) || observation.expires <= now || typeof observation.ppm !== "bigint" || abs(observation.ppm) > 2000n) throw Error("Funding observation mismatch/expiry");
      s.funding = { ppm: observation.ppm, expires: observation.expires };
      this.event(s, now, "funding-observation", "fresh finalized loop binding; PAPER only", observation, null);
      return { state: s, result: undefined };
    });
  }
  async reduce(now: number, actor?: string) {
    const authorized = await this.store.transaction(async old => {
      const s = this.checked(old, now);
      if (actor !== undefined) ownerOnly(s.policy, actor);
      else if (!s.policy.autoClose) {
        this.event(s, now, "unwind-skip", "Auto-close disabled", null, null);
        return { state: s, result: false };
      }
      if (s.state !== "settled") this.pauseState(s, now, "stop new submissions before unwind reconciliation");
      return { state: s, result: true };
    });
    if (!authorized) throw Error("Auto-close disabled");
    await this.reconcile(now);
    let s = await this.snapshot();
    for (const i of s.intents) if (i.sent && (!i.fill || ["pending", "partial"].includes(i.fill.status))) {
      const known = await this.adapter(i.request.leg).lookup(i.request.id);
      if (!known) throw Error("Unknown receipt blocks unwind");
      await this.adapter(i.request.leg).cancel(i.request.id);
    }
    await this.reconcile(now); s = await this.snapshot();
    if (this.pending(s)) throw Error("Pending orders block unwind");
    const observations = { spot: await this.spot.observe(now), perp: await this.perp.observe(now) };
    const quotes = { spot: await this.spot.quote(now), perp: await this.perp.quote(now) };
    const rejected = await this.store.transaction<string | null>(async old => {
      const s = this.checked(old, now), p = s.policy;
      const decline = (reason: string) => {
        this.event(s, now, "unwind-skip", reason, observations, null);
        return { state: s, result: reason };
      };
      if (s.state === "settled") return { state: s, result: null };
      const intents: Intent[] = [];
      let cost = 0n, turnover = 0n;
      for (const leg of ["spot", "perp"] as const) {
        const size = abs(observations[leg].position), q = quotes[leg];
        if (!size) continue;
        const amount = value(size, q.price);
        cost += (amount * (q.feeBps + q.slippageBps) + 9999n) / 10_000n; turnover += amount;
        if (!fresh(q, now) || size * 10_000n > q.depth * p.maxParticipationBps || q.slippageBps > p.maxSlippageBps) return decline("Unwind oracle/depth/slippage unavailable");
        intents.push({ request: { id: `${p.strategy}/${s.epoch}/close-${s.retries}/${leg}`, strategy: p.strategy, leg, side: leg === "spot" ? "sell" : "buy", size, quote: q, reduceOnly: true }, sent: false, fill: null });
      }
      if (!intents.length) {
        s.state = transition(s.state, "settled"); s.stopped = true; s.intents = []; s.reservedCosts = 0n;
        this.event(s, now, "unwind", "already flat and reconciled; no trade/retry required", observations, { cost: 0n, intents });
        return { state: s, result: null };
      }
      if (cost > p.maxActionCost || s.costs + cost > p.maxTotalCost || turnover + s.turnover > p.maxDailyTurnover || s.retries >= p.maxRetries) return decline("Unwind cost/turnover/retry budget exhausted");
      s.retries++; s.state = transition(s.state, "unwinding"); s.stopped = true; s.intents = intents; s.reservedCosts = cost;
      this.event(s, now, "unwind", actor ? "owner requested bounded close" : "policy-authorized close", observations, { cost, intents });
      return { state: s, result: null };
    });
    if (rejected) throw Error(rejected);
  }
  // Bounded repair reduces the surplus leg; never increases a broken hedge.
  async repair(now: number) {
    await this.reconcile(now);
    const snapshot = await this.snapshot();
    const q = { spot: await this.spot.quote(now), perp: await this.perp.quote(now) };
    const rejected = await this.store.transaction<string | null>(async old => {
      const s = this.checked(old, now), p = s.policy;
      if (!p.autoReduce || s.stopped || this.pending(s) || !s.observations || !["opening", "hedged", "repairing"].includes(s.state)) {
        this.event(s, now, "repair-skip", "Repair not authorized/pending/stopped", null, null);
        return { state: s, result: "Repair not authorized/pending/stopped" };
      }
      if (hash(s.observations) !== hash(snapshot.observations)) throw Error("Changed observations");
      const delta = s.observations.spot.position + s.observations.perp.position;
      const leg = delta > 0n ? "spot" : "perp", size = abs(delta), quote = q[leg];
      const cost = (value(size, quote.price) * (quote.feeBps + quote.slippageBps) + 9999n) / 10_000n;
      const turnover = value(size, quote.price);
      if (!size || !fresh(quote, now) || quote.slippageBps > p.maxSlippageBps || size * 10_000n > quote.depth * p.maxParticipationBps || s.retries >= p.maxRetries || cost > p.maxActionCost || cost + s.costs > p.maxTotalCost || turnover + s.turnover > p.maxDailyTurnover || (s.lastAction !== null && now - s.lastAction < p.cooldownSeconds)) {
        this.event(s, now, "repair-skip", "Repair bounds/cooldown exhausted", s.observations, { cost, delta });
        return { state: s, result: "Repair bounds/cooldown exhausted" };
      }
      s.retries++; s.state = transition(s.state, "repairing"); s.reservedCosts = cost;
      s.intents = [{ request: { id: `${p.strategy}/${s.epoch}/repair-${s.retries}/${leg}`, strategy: p.strategy, leg, side: leg === "spot" ? "sell" : "buy", size, quote, reduceOnly: true }, sent: false, fill: null }];
      this.event(s, now, "repair", "reduce surplus only", s.observations, { cost, delta });
      return { state: s, result: null };
    });
    if (rejected) throw Error(rejected);
  }
}
