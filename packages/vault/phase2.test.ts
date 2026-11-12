import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperAdapter } from "../adapters/paper";
import { type Quote, type Adapter } from "../adapters/types";
import { executionReadiness, requirePaper } from "../adapters/execution-gate";
import { type Policy, policyHash } from "../risk/policy";
import { transition, type State } from "../risk/state-machine";
import { watchdog } from "../risk/watchdog";
import { evaluate, type Opportunity } from "./opportunity";
import { sizeHedge } from "./sizing";
import { Store, hash, encode, decode } from "./store";
import { appendEvent, replay, type DecisionEvent } from "./events";
import { replayDecisions } from "./replay";
import { Guardian, type Journal } from "../../services/guardian/guardian";

const policy: Policy = { version: 1, revision: 1, owner: "alice.testnet", strategy: "alpha", mode: "PAPER", autoOpen: true, autoReduce: true, autoClose: true, maxGross: 300_000_000n, maxDelta: 1_000_000n, maxDeltaSeconds: 60, minReserve: 1_000_000n, minMarginBps: 1000n, maxSlippageBps: 20n, maxDailyTurnover: 1_000_000_000n, minNetCarry: 1n, maxActionCost: 1_000_000n, maxTotalCost: 10_000_000n, cooldownSeconds: 0, maxRetries: 3, maxParticipationBps: 5000n };
const quote = (leg: "spot" | "perp"): Quote => ({ mode: "PAPER", leg, market: "NEAR/USD", id: `${leg}-1`, at: 100, expires: 1000, price: 100_000_000n, depth: 10_000_000n, feeBps: 3n, slippageBps: 2n, available: true });
const opportunity = (): Opportunity => ({ at: 100, epoch: 1, configRevision: 1, fundingPpm: 2000n, horizonSeconds: 14_400, collectibleSeconds: 14_400, payerCollateral: 100_000_000n, basisChange: 0n, repairCost: 10_000n, reserveCost: 10_000n, exitCost: 100_000n, spotCash: 500_000_000n, perpCash: 500_000_000n, size: 1_000_000n, spot: quote("spot"), perp: quote("perp") });
async function fixture(fn: (f: { g: Guardian; spot: PaperAdapter; perp: PaperAdapter; dir: string; store: Store<Journal> }) => Promise<void>, p = policy) {
  const dir = await mkdtemp(join(tmpdir(), "reflex-phase2-"));
  try {
    const spot = new PaperAdapter("spot", new Store(join(dir, "spot.json")));
    const perp = new PaperAdapter("perp", new Store(join(dir, "perp.json")));
    await spot.initialize("alpha", 500_000_000n, quote("spot"));
    await perp.initialize("alpha", 500_000_000n, quote("perp"), 100_000_000n);
    const store = new Store<Journal>(join(dir, "guardian.json"));
    const g = new Guardian(store, spot, perp);
    await g.create(p, p.owner);
    await fn({ g, spot, perp, dir, store });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function open(g: Guardian, spot: PaperAdapter, perp: PaperAdapter) {
  assert.equal(await g.propose(opportunity(), 100), true);
  const s = await g.snapshot();
  for (const i of s.intents) {
    await g.dispatch(i.request.id, 100);
    await (i.request.leg === "spot" ? spot : perp).fill(i.request.id, i.request.size, 100);
    await g.reconcile(100);
  }
  assert.equal((await g.snapshot()).state, "hedged");
}

test("policy schema, immutable hash, identity and permission bounds", async () => {
  assert.equal(policyHash(policy), policyHash(Object.fromEntries(Object.entries(policy).reverse()) as unknown as Policy));
  for (const patch of [{ maxGross: -1n }, { minMarginBps: 999n }, { maxRetries: NaN }, { autoOpen: "yes" }, { mode: "NEAR_TESTNET" }, { surprise: true }]) assert.throws(() => policyHash({ ...policy, ...patch } as Policy));
  await fixture(async ({ g, store }) => {
    await assert.rejects(g.pause("bob.testnet", 100), /Owner/);
    await assert.rejects(g.create(policy, policy.owner), /immutable/);
    await store.transaction(async s => { s!.policy.maxGross++; return { state: s!, result: undefined }; });
    await assert.rejects(g.snapshot(), /tampered/);
  });
});
test("all lifecycle edges are explicit; settled terminal", () => {
  const allowed: Record<State, State[]> = { draft: ["quoting", "paused", "settled"], quoting: ["opening", "paused", "settled"], opening: ["hedged", "repairing", "paused", "unwinding"], hedged: ["repairing", "paused", "unwinding"], repairing: ["hedged", "paused", "unwinding"], paused: ["unwinding", "settled"], unwinding: ["settled", "paused"], settled: [] };
  for (const from of Object.keys(allowed) as State[]) for (const to of Object.keys(allowed) as State[]) {
    if (from === to || allowed[from].includes(to)) assert.equal(transition(from, to), to);
    else assert.throws(() => transition(from, to));
  }
});
test("opportunities reject positive gross/negative net, reversal, cap, depth, margin, optimism and stale quotes", () => {
  const o = opportunity(); assert.equal(evaluate(policy, o, 100).allowed, true);
  for (const patch of [{ fundingPpm: 1n }, { collectibleSeconds: 0 }, { payerCollateral: 1n }, { basisChange: -900_000n }, { spotCash: 0n }, { perpCash: 0n }, { size: 0n }, { basisChange: 1n }, { spot: { ...o.spot, depth: 1n } }, { perp: { ...o.perp, expires: 100 } }, { spot: { ...o.spot, at: 101 } }, { fundingPpm: -1n }]) assert.equal(evaluate(policy, { ...o, ...patch }, 100).allowed, false, encode(patch));
  assert.equal(evaluate({ ...policy, autoOpen: false }, o, 100).allowed, false);
});
test("independent pending/partial fills, deterministic idempotence and conflict rejection", async () => fixture(async ({ g, spot, perp }) => {
  await g.propose(opportunity(), 100);
  const [a, b] = (await g.snapshot()).intents;
  await g.dispatch(a.request.id, 100); await spot.fill(a.request.id, 400_000n, 100);
  await g.dispatch(b.request.id, 100); await g.reconcile(100);
  assert.equal((await g.snapshot()).observations!.spot.position, 400_000n);
  assert.equal((await g.snapshot()).observations!.perp.position, 0n);
  assert.equal((await perp.lookup(b.request.id))!.status, "pending");
  assert.deepEqual(await spot.submit(a.request, 100), await spot.lookup(a.request.id));
  await assert.rejects(spot.submit({ ...a.request, size: 2n }, 100), /Conflicting/);
  await assert.rejects(spot.submit({ ...a.request, id: "__proto__" }, 100), /Invalid/);
  assert.equal(await spot.lookup("constructor"), null);
  await assert.rejects(spot.cancel("constructor"), /Unknown/);
  await assert.rejects(spot.fill(a.request.id, 399_999n, 100), /Invalid/);
  await spot.fill(a.request.id, 1_000_000n, 100); await perp.fill(b.request.id, 1_000_000n, 100); await g.reconcile(100);
  const before = await g.snapshot(); await g.reconcile(100);
  assert.equal((await g.snapshot()).costs, before.costs);
  assert.equal((await g.snapshot()).turnover, before.turnover);
  assert.equal((await g.snapshot()).state, "hedged");
  assert.equal(replayDecisions((await g.snapshot()).events, policy).costs, (await g.snapshot()).costs);
}));
test("restart after timeout-then-success reconciles without duplicate submit", async () => fixture(async ({ g, spot, perp, store }) => {
  await g.propose(opportunity(), 100);
  const [a] = (await g.snapshot()).intents;
  let calls = 0;
  const lost: Adapter = { mode: "PAPER", leg: "spot", quote: n => spot.quote(n), observe: n => spot.observe(n), lookup: id => spot.lookup(id), cancel: id => spot.cancel(id), submit: async (r, n) => { calls++; await spot.submit(r, n); throw Error("secret must not be logged"); } };
  await new Guardian(store, lost, perp).dispatch(a.request.id, 100);
  await spot.fill(a.request.id, a.request.size, 100);
  await new Guardian(store, lost, perp).dispatch(a.request.id, 100);
  assert.equal(calls, 1); assert.equal((await g.snapshot()).observations!.spot.position, a.request.size);
  assert.ok(!encode((await g.snapshot()).events).includes("secret must"));
}));
test("unknown receipt pauses and never blindly resubmits", async () => fixture(async ({ g, spot, perp, store }) => {
  await g.propose(opportunity(), 100); const [a] = (await g.snapshot()).intents;
  let calls = 0;
  const lost: Adapter = { mode: "PAPER", leg: "spot", quote: n => spot.quote(n), observe: n => spot.observe(n), lookup: async () => null, cancel: id => spot.cancel(id), submit: async () => { calls++; throw Error("timeout"); } };
  const worker = new Guardian(store, lost, perp);
  await worker.dispatch(a.request.id, 100); await worker.dispatch(a.request.id, 100);
  assert.equal(calls, 1); assert.equal((await g.snapshot()).state, "paused");
  await assert.rejects(g.reduce(100, policy.owner), /Unknown receipt/);
}));
test("owner pause retains pending; bounded close cancels and reconciles late fills", async () => fixture(async ({ g, spot, perp }) => {
  await g.propose(opportunity(), 100); const [a, b] = (await g.snapshot()).intents;
  await g.dispatch(a.request.id, 100); await g.pause(policy.owner, 100);
  await spot.fill(a.request.id, 500_000n, 100); await g.reconcile(100);
  await assert.rejects(g.dispatch(b.request.id, 100), /stopped/);
  assert.equal((await g.snapshot()).observations!.spot.position, 500_000n);
  await g.reduce(100, policy.owner);
  for (const i of (await g.snapshot()).intents) { await g.dispatch(i.request.id, 100); await (i.request.leg === "spot" ? spot : perp).fill(i.request.id, i.request.size, 100); }
  await g.reconcile(100); assert.equal((await g.snapshot()).state, "settled");
  await assert.rejects(spot.fill(a.request.id, 1_000_000n, 100), /not pending/);
}));
test("counterparty exit exposes residual spot; bounded unwind, not assumed neutrality", async () => fixture(async ({ g, spot, perp }) => {
  await open(g, spot, perp); await perp.counterpartyClose(101); await g.reconcile(101);
  assert.equal((await g.snapshot()).observations!.perp.position, 0n);
  await g.repair(101);
  const [i] = (await g.snapshot()).intents; assert.equal(i.request.leg, "spot"); assert.equal(i.request.reduceOnly, true);
  await g.dispatch(i.request.id, 101); await spot.fill(i.request.id, i.request.size, 101); await g.reconcile(101);
  assert.equal((await g.snapshot()).observations!.spot.position, 0n);
}));
test("funding transfer and crash settlement conserve capped bilateral PAPER collateral", async () => fixture(async ({ g, spot, perp }) => {
  await open(g, spot, perp);
  const before = await perp.observe(100);
  await perp.funding(1_000_000_000n); const funded = await perp.observe(100);
  assert.equal(funded.margin + funded.payerCollateral, before.margin + before.payerCollateral);
  assert.equal(funded.payerCollateral, 0n);
  await perp.market({ ...quote("perp"), id: "crash", at: 101, price: 1_000_000n });
  await perp.counterpartyClose(101); const after = await perp.observe(101);
  assert.equal(after.capBinding, true);
  assert.equal(after.cash + after.margin + after.payerCollateral + after.costs, before.cash + before.margin + before.payerCollateral + before.costs);
  await g.reconcile(101); assert.equal((await g.snapshot()).state, "paused");
}));
test("unavailable oracle, depletion and disabled permissions block action", async () => fixture(async ({ g, spot, perp }) => {
  await open(g, spot, perp);
  await perp.market({ ...quote("perp"), available: false }); await g.reconcile(101);
  assert.equal((await g.snapshot()).state, "paused");
  await assert.rejects(g.reduce(101, policy.owner), /unavailable/);
  await assert.rejects(g.repair(101), /not authorized/);
}));
test("disabled auto-close/reduce and total budget cannot authorize repair", async () => fixture(async ({ g, spot, perp }) => {
  await open(g, spot, perp); await perp.counterpartyClose(101);
  await assert.rejects(g.repair(101), /not authorized/);
  await assert.rejects(g.reduce(101), /disabled/);
  await g.reduce(101, policy.owner);
}, { ...policy, autoReduce: false, autoClose: false }));
test("watchdog checks exact delta duration, reserve, funding sign, margin and gross boundaries", async () => fixture(async ({ spot, perp }) => {
  const a = await spot.observe(100), b = await perp.observe(100);
  assert.equal(watchdog(policy, a, b, quote("perp"), 1n, 100, null).reason, null);
  assert.match(watchdog(policy, { ...a, position: 1n }, b, quote("perp"), 1n, 100, 40).reason!, /duration/);
  assert.match(watchdog(policy, { ...a, cash: 0n }, b, quote("perp"), 1n, 100, null).reason!, /reserve/);
  assert.match(watchdog(policy, { ...a, position: 1n }, b, quote("perp"), 0n, 100, null).reason!, /reversal/);
  assert.match(watchdog(policy, a, { ...b, position: -1_000_000n, margin: 0n }, quote("perp"), 1n, 100, null).reason!, /margin/);
}));
test("audit replay, bounded persistence, corruption and exclusive writers fail closed", async () => fixture(async ({ g, store, dir }) => {
  await g.propose({ ...opportunity(), fundingPpm: 0n }, 100);
  const s = await g.snapshot(); assert.equal(s.events.at(-1)!.kind, "skip");
  assert.equal(replay(decode(encode(s.events))), replay(s.events));
  const redacted: DecisionEvent[] = [];
  const context = { strategy: policy.strategy, mode: "PAPER" as const, policyHash: policyHash(policy), policyRevision: 1, epoch: 1, configRevision: 1, at: 100, kind: "observe", reason: "fixture", input: { privateKey: "do-not-log", nested: { apiKey: "also-secret" } }, result: null };
  appendEvent(redacted, context); assert.ok(!encode(redacted).includes("do-not-log")); assert.ok(!encode(redacted).includes("also-secret"));
  const full = Array.from({ length: 4096 }, () => redacted[0]);
  assert.throws(() => appendEvent(full, context), /archive capacity/);
  const changed = decode<typeof s.events>(encode(s.events)); changed[0].reason = "forged"; assert.throws(() => replay(changed));
  const lock = `${store.path}.lock`; await writeFile(lock, "operator inspection");
  await assert.rejects(g.pause(policy.owner, 100), /EEXIST/); await rm(lock);
  const envelope = JSON.parse(await readFile(store.path, "utf8")); envelope.payload += " "; await writeFile(store.path, JSON.stringify(envelope));
  await assert.rejects(store.load(), /Corrupt/);
  assert.ok(!JSON.stringify(envelope).includes("privateKey"));
  assert.equal(hash(s.policy), hash(decode(encode(s.policy))));
  assert.ok(dir);
}));
test("integer sizing never exceeds request, collateral, gross, transient delta or depth", () => {
  const o = opportunity();
  const sized = sizeHedge({ ...policy, maxGross: 100_000_000n }, o, 100);
  assert.equal(sized.size, 500_000n); assert.equal(sized.evaluation.allowed, true);
  const depth = sizeHedge(policy, { ...o, spot: { ...o.spot, depth: 1_000_000n } }, 100);
  assert.equal(depth.size, 500_000n);
  assert.equal(sizeHedge(policy, { ...o, fundingPpm: 0n }, 100).evaluation.allowed, false);
  assert.equal(sizeHedge(policy, { ...o, spotCash: 1n }, 100).evaluation.allowed, false);
});
test("genuine and mixed execution remain explicitly gated", async () => fixture(async ({ spot, perp, store }) => {
  assert.equal(executionReadiness("PAPER").enabled, true);
  for (const mode of ["NEAR_TESTNET", "SPOT_REAL"] as const) { assert.equal(executionReadiness(mode).enabled, false); assert.throws(() => requirePaper(mode), /disabled/); }
  assert.throws(() => new Guardian(store, { ...spot, mode: "NEAR_TESTNET" } as unknown as Adapter, perp), /PAPER-only/);
}));

test("stale quotes, epoch replay and conservative budget gates do not submit", async () => fixture(async ({ g, spot }) => {
  assert.equal(await g.propose({ ...opportunity(), fundingPpm: 0n }, 100), false);
  assert.equal(await g.propose(opportunity(), 100), false);
  assert.equal(await g.propose({ ...opportunity(), epoch: 2 }, 100), true);
  const [i] = (await g.snapshot()).intents;
  await spot.market({ ...quote("spot"), id: "new-book" });
  await g.dispatch(i.request.id, 100);
  assert.equal((await g.snapshot()).state, "paused");
  assert.equal(await spot.lookup(i.request.id), null);
}));
test("failed second leg stops, records residual exposure and honors unwind retries", async () => fixture(async ({ g, spot, perp }) => {
  await g.propose(opportunity(), 100);
  const [a, b] = (await g.snapshot()).intents;
  await g.dispatch(a.request.id, 100); await spot.fill(a.request.id, a.request.size, 100);
  await g.dispatch(b.request.id, 100); await perp.cancel(b.request.id); await g.reconcile(100);
  assert.equal((await g.snapshot()).state, "paused");
  assert.equal((await g.snapshot()).observations!.spot.position, a.request.size);
  await assert.rejects(g.reduce(100, policy.owner), /retry budget/);
}, { ...policy, maxRetries: 0 }));
test("conflicting/out-of-order revisions are not ingested", async () => fixture(async ({ g, spot, perp, store }) => {
  await open(g, spot, perp);
  const old = await g.snapshot();
  const bad: Adapter = { mode: "PAPER", leg: "spot", quote: n => spot.quote(n), observe: n => spot.observe(n), cancel: id => spot.cancel(id), submit: (r,n) => spot.submit(r,n), lookup: async id => {
    const f = await spot.lookup(id); return f ? { ...f, revision: 0, filled: 0n, status: "pending" } : null;
  } };
  await new Guardian(store, bad, perp).reconcile(101);
  const after = await g.snapshot();
  assert.equal(after.state, "paused"); assert.equal(after.intents[0].fill!.filled, old.intents[0].fill!.filled);
  assert.equal(after.costs, old.costs);
}));
test("nonlinear cap is visible before close and stops new actions", async () => fixture(async ({ g, spot, perp }) => {
  await open(g, spot, perp);
  await perp.funding(100_000_000n);
  await perp.market({ ...quote("perp"), id: "crash-before-close", at: 101, price: 1_000_000n });
  assert.equal((await perp.observe(101)).capBinding, true);
  await g.reconcile(101); assert.equal((await g.snapshot()).state, "paused");
}));
test("single-leg PAPER balance/depth failures conserve without crediting the other venue", async () => fixture(async ({ spot, perp }) => {
  const r = { id: "alpha/manual/spot", strategy: "alpha", leg: "spot" as const, side: "buy" as const, size: 10_000_000n, quote: quote("spot"), reduceOnly: false };
  await spot.submit(r, 100);
  const before = await spot.observe(100), other = await perp.observe(100);
  await assert.rejects(spot.fill(r.id, r.size, 100), /Insufficient/);
  assert.deepEqual(await spot.observe(100), before); assert.deepEqual(await perp.observe(100), other);
  const expired = await spot.submit({ ...r, id: "alpha/expired/spot" }, 1000);
  assert.equal(expired.status, "rejected");
}));
test("liquidity depletion and unexplained venue exposure pause rather than reopen", async () => {
  await fixture(async ({ g, spot, perp }) => {
    await open(g, spot, perp);
    await spot.market({ ...quote("spot"), id: "depleted", depth: 0n });
    await g.reconcile(101); assert.equal((await g.snapshot()).state, "paused");
    assert.match((await g.snapshot()).events.at(-1)!.reason, /liquidity/);
    await assert.rejects(g.reduce(101, policy.owner), /unavailable/);
  });
  await fixture(async ({ g, spot, perp, store }) => {
    await open(g, spot, perp);
    const changed: Adapter = { mode: "PAPER", leg: "spot", quote: n => spot.quote(n), observe: async n => ({ ...await spot.observe(n), position: 1_000_001n }), lookup: id => spot.lookup(id), cancel: id => spot.cancel(id), submit: (r,n) => spot.submit(r,n) };
    await new Guardian(store, changed, perp).reconcile(101);
    assert.equal((await g.snapshot()).state, "paused");
    assert.ok((await g.snapshot()).events.some(e => e.reason === "unexplained venue exposure"));
  });
});
test("already flat owner settlement needs no trading permission, retry or oracle", async () => fixture(async ({ g, spot, perp }) => {
  await spot.market({ ...quote("spot"), available: false });
  await perp.market({ ...quote("perp"), available: false });
  await g.reduce(101, policy.owner);
  assert.equal((await g.snapshot()).state, "settled");
  assert.equal((await g.snapshot()).retries, 0);
}, { ...policy, autoClose: false, maxRetries: 0 }));
test("cost, turnover, depth divergence and reserve boundaries decline opportunities", async () => {
  const o = opportunity();
  for (const p of [{ ...policy, maxActionCost: 0n }, { ...policy, maxTotalCost: 0n, maxActionCost: 0n }, { ...policy, maxGross: 199_999_999n }]) assert.equal(evaluate(p, o, 100).allowed, false);
  assert.equal(evaluate(policy, { ...o, perp: { ...o.perp, price: 104_000_000n } }, 100).allowed, false);
  await fixture(async ({ g }) => {
    assert.equal(await g.propose(o, 100), false);
    assert.match((await g.snapshot()).events.at(-1)!.reason, /turnover/);
  }, { ...policy, maxDailyTurnover: 199_999_999n });
});
