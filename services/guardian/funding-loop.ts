import { abs, value } from "../../packages/adapters/types";
import { advanceFeedback, entryReason, feedbackHash, projectedCosts, quoteReason, type FeedbackPolicy, type FeedbackState } from "../../packages/risk/feedback";
import { appendEvent, replay, type DecisionEvent } from "../../packages/vault/events";
import { sizeHedge } from "../../packages/vault/sizing";
import type { Opportunity } from "../../packages/vault/opportunity";
import { hash, Store } from "../../packages/vault/store";
import { signalFrom, type FundingSource, type Signal } from "./funding-source";
import { Guardian } from "./guardian";

interface Plan {
  epoch: number; binding: string; opportunity: Opportunity; size: bigint; costs: bigint;
  stage: "reserved" | "active" | "declined" | "invalidated";
}
interface Member { policyHash: string; maxSize: bigint; decisionEpoch: number; plan: Plan | null; }
export interface LoopJournal {
  version: 1; policy: FeedbackPolicy; policyHash: string; clock: number;
  feedback: FeedbackState; signal: Signal | null; members: Record<string, Member>; events: DecisionEvent[];
}

/** Single-host, PAPER-only coordinator. Its source is read-only; fills are venue events,
 * never invented here. One group entry per epoch prevents immediate self-recursion.
 */
export class FundingLoop {
  private worker: Store<never>;
  constructor(readonly store: Store<LoopJournal>, readonly source: FundingSource, readonly guardians: readonly Guardian[], private readonly sandboxClock?: () => number) {
    this.worker = new Store(`${store.path}.worker`);
    if (!guardians.length || guardians.length > 16) throw Error("Bounded PAPER membership required");
  }
  private checked(s: LoopJournal | null, now: number): LoopJournal {
    if (!s || s.version !== 1 || feedbackHash(s.policy) !== s.policyHash) throw Error("Missing/tampered feedback policy");
    now = this.time(s.policy, now);
    if (!Number.isSafeInteger(now) || now < s.clock || now < 0) throw Error("Invalid/reversed loop clock");
    replay(s.events); s.clock = now;
    return s;
  }
  private time(policy: FeedbackPolicy, fixtureTime: number) {
    return policy.scope === "LOCAL_FIXTURE" ? fixtureTime : policy.scope === "LOCAL_SANDBOX" && this.sandboxClock ? this.sandboxClock() : Math.floor(Date.now() / 1000);
  }
  private event(s: LoopJournal, now: number, kind: string, reason: string, input: unknown = null, result: unknown = null) {
    appendEvent(s.events, { strategy: `market:${s.policy.marketId}`, mode: "PAPER", policyHash: s.policyHash, policyRevision: 1,
      epoch: s.feedback.epoch, configRevision: s.signal?.revision ?? 0, at: s.clock, kind, reason, input, result });
  }
  async initialize(policy: FeedbackPolicy, maxSizes: Record<string, bigint>) {
    const policyHash = feedbackHash(policy), members: Record<string, Member> = Object.create(null);
    for (const g of this.guardians) {
      const s = await g.snapshot(), id = s.policy.strategy, size = maxSizes[id];
      if (Object.hasOwn(members, id) || typeof size !== "bigint" || size <= 0n || size > 10n ** 30n) throw Error("Invalid/duplicate loop membership");
      members[id] = { policyHash: s.policyHash, maxSize: size, decisionEpoch: -1, plan: null };
    }
    if (Object.keys(maxSizes).length !== this.guardians.length) throw Error("Unexpected loop membership");
    await this.store.transaction(async old => {
      if (old) throw Error("Loop already initialized; never reset budgets/pending plans");
      const s: LoopJournal = { version: 1, policy, policyHash, clock: 0, signal: null, members, events: [], feedback: {
        epoch: -1, revision: 0, streak: 0, lastAction: null, entries: 0, epochGross: 0n, epochCosts: 0n, day: 0, dailyGross: 0n,
      } };
      this.event(s, 0, "confirm", "local PAPER group policy and membership pinned", { policy, members });
      return { state: s, result: undefined };
    });
  }
  async snapshot() { const s = await this.store.load(); return this.checked(s, s?.clock ?? 0); }
  private async note(now: number, kind: string, reason: string, input: unknown = null, result: unknown = null) {
    await this.store.transaction(async old => { const s = this.checked(old, now); this.event(s, now, kind, reason, input, result); return { state: s, result: undefined }; });
  }
  private async observe(now: number): Promise<Signal> {
    const journal = await this.snapshot();
    const read = await this.source.read();
    now = this.time(journal.policy, now); // Recheck wall time AFTER RPC, not the tick's cached start time.
    const signal = signalFrom(read, journal.policy.contract, journal.policy.marketId, now);
    await this.store.transaction(async old => {
      const s = this.checked(old, now), previous = s.signal;
      if (signal.scope !== s.policy.scope || (previous && (signal.blockHeight < previous.blockHeight || signal.at < previous.at || signal.epoch < previous.epoch || signal.revision < previous.revision
        || (signal.blockHeight === previous.blockHeight && (signal.blockHash !== previous.blockHash || signal.snapshotHash !== previous.snapshotHash))))) throw Error("Regressed/conflicting finalized snapshot");
      s.feedback = advanceFeedback(s.policy, s.feedback, signal, now); s.signal = signal;
      this.event(s, now, "funding", signal.inactiveReason ?? "validated finalized funding observation", signal);
      return { state: s, result: undefined };
    });
    return signal;
  }
  private async updatePlan(id: string, stage: Plan["stage"], now: number, reason: string) {
    await this.store.transaction(async old => {
      const s = this.checked(old, now);
      if (s.members[id]?.plan) s.members[id].plan!.stage = stage;
      this.event(s, now, "plan", reason, { strategy: id, stage });
      return { state: s, result: undefined };
    });
  }
  private async market(g: Guardian, signal: Signal, now: number) {
    const id = (await g.snapshot()).policy.strategy;
    await this.note(now, "market-observation", "reconciled PAPER execution changes PAPER depth/exposure only; chain matched OI is not rewritten", { strategy: id, signal }, {
      spot: { quote: await g.spot.quote(now), observation: await g.spot.observe(now) }, perp: { quote: await g.perp.quote(now), observation: await g.perp.observe(now) },
      matchedOpenInterest: signal.matchedOpenInterest,
    });
  }
  private async halt(g: Guardian, now: number, reason: string) {
    now = this.time((await this.snapshot()).policy, now);
    const s = await g.snapshot();
    if (s.state !== "settled") await g.pause(s.policy.owner, now, reason);
    if ((await this.snapshot()).members[s.policy.strategy]?.plan) await this.updatePlan(s.policy.strategy, "invalidated", now, reason);
    let unknown = false;
    for (const i of s.intents) {
      if (!i.sent || (i.fill && !["pending", "partial"].includes(i.fill.status))) continue;
      const adapter = i.request.leg === "spot" ? g.spot : g.perp;
      try {
        const known = await adapter.lookup(i.request.id);
        if (!known) { unknown = true; continue; }
        await adapter.cancel(i.request.id);
      } catch { unknown = true; }
    }
    try { await g.reconcile(now, 0n); } catch { unknown = true; }
    await this.note(now, "pause", reason, { strategy: s.policy.strategy }, { unresolved: unknown, action: "stop/cancel known pending/reconcile; no invented exit" });
  }
  private async reserve(g: Guardian, signal: Signal, now: number): Promise<boolean> {
    const gs = await g.snapshot(), id = gs.policy.strategy, journal = await this.snapshot(), member = journal.members[id];
    if (!member || member.policyHash !== gs.policyHash) throw Error("Loop membership/policy changed");
    if (member.decisionEpoch >= signal.epoch) return false;
    const spot = await g.spot.quote(now), perp = await g.perp.quote(now);
    const balances = { spot: await g.spot.observe(now), perp: await g.perp.observe(now) };
    now = this.time(journal.policy, now);
    const groupDepth = (spot.depth < perp.depth ? spot.depth : perp.depth) * journal.policy.maxParticipationBps / 10_000n;
    const maximum = member.maxSize < groupDepth ? member.maxSize : groupDepth;
    const opportunity: Opportunity = {
      at: now, epoch: signal.epoch, configRevision: signal.revision, fundingPpm: signal.ppm, fundingExpiresAt: signal.expires,
      // Forecast assumes continued oracle publication, not guaranteed accrual past current oracle expiry.
      horizonSeconds: journal.policy.horizonSeconds, collectibleSeconds: Math.max(0, Math.min(journal.policy.horizonSeconds, signal.rateAppliedAt + 3600 - now)),
      payerCollateral: balances.perp.payerCollateral, basisChange: 0n, repairCost: journal.policy.repairCost, reserveCost: journal.policy.reserveCost,
      exitCost: projectedCosts(maximum, spot, perp), spotCash: balances.spot.cash, perpCash: balances.perp.cash, size: maximum, spot, perp,
    };
    const sized = sizeHedge(gs.policy, opportunity, now); opportunity.size = sized.size;
    return this.store.transaction(async old => {
      const s = this.checked(old, now), m = s.members[id], p = s.policy;
      if (m.decisionEpoch >= signal.epoch) return { state: s, result: false };
      now = s.clock;
      let reason = s.signal?.binding !== signal.binding || signal.expires <= now ? "funding changed/expired before reservation" : gs.state !== "draft" || gs.stopped ? "strategy not idle/owner stopped"
        : entryReason(p, s.feedback, signal, now) ?? quoteReason(p, signal, spot, perp, now);
      if (!reason && (!sized.evaluation.allowed || opportunity.collectibleSeconds === 0)) reason = sized.evaluation.reason;
      // Reserve entry plus conservative exit/repair flow up front; reductions never
      // recycle this allowance into another entry (and never increase inventory).
      const reservedGross = sized.evaluation.gross * 3n;
      if (!reason && (s.feedback.epochGross + reservedGross > p.maxEpochGross || s.feedback.dailyGross + reservedGross > p.maxDailyGross || s.feedback.epochCosts + sized.evaluation.costs > p.maxEpochCosts)) reason = "shared flow/cost budget";
      m.decisionEpoch = signal.epoch;
      if (reason) { this.event(s, now, "skip", reason, { strategy: id, signal, opportunity }, sized.evaluation); return { state: s, result: false }; }
      // Persist group budget and pending plan BEFORE calling Guardian or a venue.
      m.plan = { epoch: signal.epoch, binding: signal.binding, opportunity, size: sized.size, costs: sized.evaluation.costs, stage: "reserved" };
      s.feedback.entries++; s.feedback.epochGross += reservedGross; s.feedback.dailyGross += reservedGross; s.feedback.epochCosts += sized.evaluation.costs; s.feedback.lastAction = now;
      this.event(s, now, "reserve", "one policy-approved market entry; budget never recycled on uncertainty", { strategy: id, signal, opportunity }, sized.evaluation);
      return { state: s, result: true };
    });
  }
  private async process(g: Guardian, now: number) {
    let gs = await g.snapshot();
    const id = gs.policy.strategy, journal = await this.snapshot(), member = journal.members[id], plan = member?.plan;
    if (!member || member.policyHash !== gs.policyHash) throw Error("Loop membership/policy changed");
    if (!plan || plan.stage === "declined") return;
    if (plan.stage === "invalidated") {
      if (gs.state !== "settled" && gs.intents.some(i => i.sent && (!i.fill || ["pending", "partial"].includes(i.fill.status)))) await this.halt(g, now, "stopped plan received late pending events; reconcile/cancel only");
      return;
    }
    const signal = await this.observe(now);
    now = signal.observedAt;
    if (!signal.usable || signal.binding !== plan.binding || signal.ppm <= journal.policy.exitPpm) {
      await this.halt(g, now, "funding/config/oracle change invalidated old plan"); return;
    }
    await g.reconcile(now, signal.ppm); gs = await g.snapshot();
    if (gs.costs > plan.costs) { await this.halt(g, now, "shared reserved cost budget exhausted"); return; }
    if (gs.stopped || gs.state === "settled") {
      if (gs.state !== "settled") await this.halt(g, now, "strategy stopped; no resumed opens");
      else await this.market(g, signal, now);
      return;
    }
    if (plan.stage === "reserved") {
      if (gs.state === "draft" && gs.epoch < plan.epoch) {
        const allowed = await g.propose({ ...plan.opportunity, at: now, collectibleSeconds: Math.max(0, plan.opportunity.collectibleSeconds - (now - plan.opportunity.at)) }, now);
        if (!allowed) { await this.updatePlan(id, "declined", now, "Guardian declined reserved opportunity"); return; }
      }
      gs = await g.snapshot();
      if (gs.epoch !== plan.epoch || gs.configRevision !== plan.opportunity.configRevision || gs.intents.length !== 2 || gs.intents.some(i => i.request.reduceOnly || i.request.size !== plan.size || hash(i.request.quote) !== hash(plan.opportunity[i.request.leg]))) {
        await this.halt(g, now, "reserved plan conflicts with existing Guardian state"); return;
      }
      await this.updatePlan(id, "active", now, "Guardian proposal recognized; resume stable IDs only");
    }
    gs = await g.snapshot();
    if (gs.state === "repairing" && gs.observations && gs.policy.autoReduce) {
      const delta = gs.observations.spot.position + gs.observations.perp.position;
      const q = await (delta > 0n ? g.spot : g.perp).quote(now);
      const cost = (value(abs(delta), q.price) * (q.feeBps + q.slippageBps) + 9999n) / 10_000n;
      if (gs.costs + cost > plan.costs) { await this.halt(g, now, "shared reserved repair budget exhausted"); return; }
      try { await g.repair(now); } catch { await this.halt(g, now, "bounded repair unavailable; residual exposure retained"); return; }
    }
    for (const intent of (await g.snapshot()).intents) {
      if (intent.sent) continue;
      const fresh = await this.observe(now);
      now = fresh.observedAt;
      if (!fresh.usable || fresh.binding !== plan.binding || fresh.ppm <= journal.policy.exitPpm) { await this.halt(g, now, "fresh pre-submit binding changed"); return; }
      const current = await g.snapshot();
      if (current.stopped) return;
      if (current.costs > plan.costs) { await this.halt(g, now, "reserved execution budget exhausted"); return; }
      await g.refreshFunding({ epoch: fresh.epoch, revision: fresh.revision, ppm: fresh.ppm, expires: Math.min(fresh.expires, intent.request.quote.expires) }, now);
      await g.dispatch(intent.request.id, now);
      if ((await g.snapshot()).stopped) { await this.halt(g, now, "leg submission/reconciliation stopped; cancel known pending"); return; }
    }
    await g.reconcile(now, signal.ppm);
    await this.market(g, signal, now);
  }
  async tick(now: number) {
    // Separate worker lock spans remote reads/actions; the journal still commits each
    // reservation before submission. Crash-held locks require operator inspection.
    return this.worker.exclusive(async () => {
      const journal = this.checked(await this.store.load(), now);
      now = journal.clock;
      const seen = new Set<string>();
      for (const g of this.guardians) {
        const s = await g.snapshot(), member = journal.members[s.policy.strategy];
        if (!member || seen.has(s.policy.strategy) || member.policyHash !== s.policyHash) throw Error("Loop membership/policy changed");
        seen.add(s.policy.strategy);
      }
      if (seen.size !== Object.keys(journal.members).length) throw Error("Loop membership missing");
      let signal: Signal;
      try { signal = await this.observe(now); }
      catch {
        for (const g of this.guardians) await this.halt(g, now, "finalized funding unavailable/conflicting; fail closed");
        return;
      }
      for (const g of this.guardians) {
        try {
          const gs = await g.snapshot();
          if (gs.state !== "settled") await g.reconcile(now, signal.ppm);
          await this.process(g, now);
          if (await this.reserve(g, signal, now)) await this.process(g, now);
        } catch {
          await this.halt(g, now, "loop/venue reconciliation failed; no blind resubmission");
        }
      }
    });
  }
}
