import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FundingSnapshot } from "../../client/lib/near/types";
import { PaperAdapter } from "../../packages/adapters/paper";
import type { Quote, Adapter } from "../../packages/adapters/types";
import { feedbackHash, type FeedbackPolicy } from "../../packages/risk/feedback";
import type { Policy } from "../../packages/risk/policy";
import { replay } from "../../packages/vault/events";
import { replayDecisions } from "../../packages/vault/replay";
import { Store, hash } from "../../packages/vault/store";
import { Guardian, type Journal } from "./guardian";
import { FundingLoop, type LoopJournal } from "./funding-loop";
import { finalizedSource, signalFrom, type FinalizedRead, type FundingSource } from "./funding-source";

const policy = (strategy: string): Policy => ({ version: 1, revision: 1, owner: "alice.testnet", strategy, mode: "PAPER", autoOpen: true, autoReduce: true, autoClose: true,
  maxGross: 300_000_000n, maxDelta: 1_000_000n, maxDeltaSeconds: 60, minReserve: 1_000_000n, minMarginBps: 1000n, maxSlippageBps: 20n,
  maxDailyTurnover: 1_000_000_000n, minNetCarry: 1n, maxActionCost: 1_000_000n, maxTotalCost: 10_000_000n, cooldownSeconds: 0, maxRetries: 3, maxParticipationBps: 5000n });
const feedback: FeedbackPolicy = { version: 1, contract: "exchange.testnet", scope: "LOCAL_FIXTURE", marketId: 1, entryPpm: 1000n, exitPpm: 100n,
  persistenceEpochs: 2, cooldownSeconds: 60, maxEpochGross: 1_000_000_000n, maxDailyGross: 3_000_000_000n, maxEpochCosts: 1_000_000n,
  maxParticipationBps: 5000n, horizonSeconds: 3600, repairCost: 10_000n, reserveCost: 10_000n };
const quote = (leg: "spot" | "perp", now: number): Quote => ({ mode: "PAPER", leg, market: "NEAR/USD", id: `${leg}-${Math.floor(now / 3600)}`, at: now, expires: now + 600,
  price: 100_000_000n, depth: 10_000_000n, feeBps: 1n, slippageBps: 0n, available: true });
function frame(now: number, rate = 2000, revision = 1): FinalizedRead {
  return { scope: "LOCAL_FIXTURE", contract: feedback.contract, finality: "final", blockHeight: 1_000_000 + now, blockHash: "11111111111111111111111111111111",
    snapshot: { timestamp: now, status: { network: "testnet", paused: false, market_count: 1 }, markets: [{ market_id: 1, symbol: "NEAR", price: "100000000000000000000", timestamp: now,
      open_interest: "1000000", paused: false, funding_rate_ppm: rate, funding_rate_bps: Math.trunc(rate / 100), controller: { mode: "ADAPTIVE", revision,
        last_epoch: Math.floor(now / 3600), rate_applied_at: Math.floor(now / 3600) * 3600, fallback: false, params: { oracle_max_age_sec: 60 } } }] } as FundingSnapshot };
}
interface Fixture {
  dir: string; loop: FundingLoop; store: Store<LoopJournal>; source: FundingSource;
  members: Array<{ g: Guardian; spot: PaperAdapter; perp: PaperAdapter; store: Store<Journal> }>;
  set(now: number, rate?: number, revision?: number): Promise<void>;
  wire: { current: FinalizedRead; onRead?: () => void; failure?: boolean };
}
async function fixture(fn: (f: Fixture) => Promise<void>, count = 1, config = feedback) {
  const dir = await mkdtemp(join(tmpdir(), "reflex-loop-"));
  try {
    const wire: Fixture["wire"] = { current: frame(3601) };
    const source = { async read() { wire.onRead?.(); if (wire.failure) throw Error("secret upstream credentials"); return structuredClone(wire.current); } };
    const members: Fixture["members"] = [];
    for (let n = 0; n < count; n++) {
      const id = `strategy-${n}`, spot = new PaperAdapter("spot", new Store(join(dir, `${id}-spot.json`))), perp = new PaperAdapter("perp", new Store(join(dir, `${id}-perp.json`)));
      await spot.initialize(id, 500_000_000n, quote("spot", 3601)); await perp.initialize(id, 500_000_000n, quote("perp", 3601), 100_000_000n);
      const store = new Store<Journal>(join(dir, `${id}-guardian.json`)), g = new Guardian(store, spot, perp); await g.create(policy(id), "alice.testnet");
      members.push({ g, spot, perp, store });
    }
    const store = new Store<LoopJournal>(join(dir, "loop.json")), loop = new FundingLoop(store, source, members.map(m => m.g));
    await loop.initialize(config, Object.fromEntries(members.map((_, n) => [`strategy-${n}`, 1_000_000n])));
    const f: Fixture = { dir, loop, store, source, wire, members, async set(now, rate = 2000, revision = 1) {
      wire.current = frame(now, rate, revision);
      for (const m of members) { await m.spot.market(quote("spot", now)); await m.perp.market(quote("perp", now)); }
    } };
    await fn(f);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function enter(f: Fixture) {
  await f.loop.tick(3601); assert.equal((await f.members[0].g.snapshot()).state, "draft");
  await f.set(7201); await f.loop.tick(7201);
  assert.equal((await f.members[0].g.snapshot()).state, "opening");
}
async function fill(f: Fixture, now = 7202) {
  const m = f.members[0];
  for (const i of (await m.g.snapshot()).intents) await (i.request.leg === "spot" ? m.spot : m.perp).fill(i.request.id, i.request.size, now);
  f.wire.current = frame(now); await f.loop.tick(now);
}

test("read-only source requests final atomic snapshot with no key or mutation", async () => {
  const f = frame(3601); let payload: unknown;
  const source = finalizedSource("http://127.0.0.1:3030", feedback.contract, "LOCAL_SANDBOX", async (_, options) => {
    payload = JSON.parse(options!.body as string);
    return new Response(JSON.stringify({ jsonrpc: "2.0", result: { block_height: f.blockHeight, block_hash: f.blockHash, result: Array.from(new TextEncoder().encode(JSON.stringify(f.snapshot))) } }));
  });
  const read = await source.read(), signal = signalFrom(read, feedback.contract, 1, 3601);
  assert.equal(signal.ppm, 2000n); assert.equal(signal.usable, true); assert.equal(signal.matchedOpenInterest, 1_000_000n);
  assert.deepEqual((payload as { params: object }).params, { request_type: "call_function", finality: "final", account_id: feedback.contract, method_name: "funding_snapshot", args_base64: "e30=" });
  assert.throws(() => finalizedSource("http://remote.test", feedback.contract, "LOCAL_SANDBOX"));
  assert.throws(() => finalizedSource("https://user:password@rpc.test", feedback.contract, "NEAR_TESTNET"));
  assert.throws(() => finalizedSource("https://rpc.test", "exchange.near", "NEAR_TESTNET"));
  const malformed = finalizedSource("https://rpc.test", feedback.contract, "NEAR_TESTNET", async () => new Response(JSON.stringify({ result: { result: [256], block_height: 1, block_hash: f.blockHash } })));
  await assert.rejects(malformed.read(), /Malformed/);
  const oversized = finalizedSource("https://rpc.test", feedback.contract, "NEAR_TESTNET", async () => new Response("x".repeat(1_000_001)));
  await assert.rejects(oversized.read(), /too large/);
});
test("snapshot validation rejects future, expired, malformed, non-final and mixed inputs", () => {
  const f = frame(3601);
  assert.throws(() => signalFrom(f, feedback.contract, 1, 3600), /snapshot/);
  assert.throws(() => signalFrom(f, feedback.contract, 1, 3662), /snapshot/);
  assert.throws(() => signalFrom({ ...f, finality: "optimistic" } as unknown as FinalizedRead, feedback.contract, 1, 3601));
  for (const patch of [{ price: "-1" }, { funding_rate_ppm: 2001 }, { funding_rate_ppm: "2000" }, { timestamp: NaN }]) {
    const bad = structuredClone(f); Object.assign(bad.snapshot.markets[0], patch); assert.throws(() => signalFrom(bad, feedback.contract, 1, 3601));
  }
  const ttl = structuredClone(f); ttl.snapshot.markets[0].controller!.params.oracle_max_age_sec = 2;
  assert.equal(signalFrom(ttl, feedback.contract, 1, 3602).usable, true);
  assert.equal(signalFrom(ttl, feedback.contract, 1, 3603).usable, false);
  const futureOracle = structuredClone(f); futureOracle.snapshot.markets[0].timestamp = 3602;
  assert.equal(signalFrom(futureOracle, feedback.contract, 1, 3601).usable, false);
  const fallback = structuredClone(f); fallback.snapshot.markets[0].controller!.fallback = true;
  assert.equal(signalFrom(fallback, feedback.contract, 1, 3601).inactiveReason, "ZERO_FALLBACK");
  const epoch = frame(7201); epoch.snapshot.markets[0].controller!.last_epoch = 1;
  assert.equal(signalFrom(epoch, feedback.contract, 1, 7201).inactiveReason, "FUNDING_EPOCH_MISMATCH");
});
test("finalized observation → persisted decision → independent fills → observed PAPER depth", async () => fixture(async f => {
  await enter(f); const { g, spot, perp } = f.members[0];
  const pending = await g.snapshot(); assert.ok(pending.intents.every(i => i.sent && i.fill?.status === "pending"));
  const before = await spot.quote(7201); await fill(f);
  assert.equal((await g.snapshot()).state, "hedged");
  assert.equal((await spot.quote(7202)).depth, before.depth - 1_000_000n);
  assert.equal((await perp.marketView()).fills[0].size, 1_000_000n);
  const event = (await f.loop.snapshot()).events.filter(e => e.kind === "market-observation").at(-1)!;
  assert.equal((event.result as { matchedOpenInterest: bigint }).matchedOpenInterest, 1_000_000n);
  assert.equal(f.wire.current.snapshot.markets[0].open_interest, "1000000"); // no fabricated chain OI feedback
  assert.equal(replayDecisions((await g.snapshot()).events, policy("strategy-0")).costs, 20_000n);
  assert.ok(replay((await f.loop.snapshot()).events));
}));
test("positive-looking gross funding is deliberately declined after net costs", async () => fixture(async f => {
  await f.loop.tick(3601); await f.set(7201);
  for (const m of f.members) {
    await m.spot.market({ ...quote("spot", 7201), feeBps: 10n }); await m.perp.market({ ...quote("perp", 7201), feeBps: 10n });
  }
  await f.loop.tick(7201); assert.equal((await f.members[0].g.snapshot()).intents.length, 0);
  assert.ok((await f.loop.snapshot()).events.some(e => e.kind === "skip" && /net carry/.test(e.reason)));
  assert.equal((await f.loop.snapshot()).feedback.entries, 0);
}));
test("replay/restart recognizes stable sent IDs and never recycles reserved budgets", async () => fixture(async f => {
  await enter(f); const { g } = f.members[0], before = await f.loop.snapshot();
  await f.store.transaction(async s => { s!.members["strategy-0"].plan!.stage = "reserved"; return { state: s!, result: undefined }; }); // crash checkpoint: Guardian persisted before loop acknowledgement
  const restarted = new FundingLoop(f.store, f.source, f.members.map(m => m.g));
  await restarted.tick(7201); await restarted.tick(7201);
  assert.equal((await g.snapshot()).events.filter(e => e.kind === "execute").length, 2);
  const after = await restarted.snapshot(); assert.equal(after.feedback.epochGross, before.feedback.epochGross); assert.equal(after.feedback.entries, 1);
  assert.equal((await g.snapshot()).intents[0].fill!.filled, 0n);
}));
test("overlapping workers refuse rather than submit competing decisions", async () => fixture(async f => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const wait = new Promise<void>(r => { release = r; });
  const slow: FundingSource = { async read() { entered(); await wait; return structuredClone(f.wire.current); } };
  const first = new FundingLoop(f.store, slow, f.members.map(m => m.g)).tick(3601);
  await started;
  await assert.rejects(new FundingLoop(f.store, f.source, f.members.map(m => m.g)).tick(3601), /EEXIST/);
  release(); await first;
  assert.equal((await f.loop.snapshot()).feedback.entries, 0);
}));
test("controller reconfiguration/manual index change invalidates old pending plans", async () => {
  for (const change of ["revision", "index"] as const) await fixture(async f => {
    await enter(f); f.wire.current = frame(7202, 2000, change === "revision" ? 2 : 1);
    if (change === "index") f.wire.current.snapshot.markets[0].price = "101000000000000000000";
    await f.loop.tick(7202); const s = await f.members[0].g.snapshot();
    assert.equal(s.state, "paused"); assert.ok(s.intents.every(i => i.fill?.status === "cancelled"));
    assert.equal((await f.loop.snapshot()).members["strategy-0"].plan!.stage, "invalidated");
    await assert.rejects(f.members[0].spot.fill(s.intents[0].request.id, 1_000_000n, 7202), /not pending/);
  });
});
test("fresh pre-submit check catches config change between non-atomic legs", async () => fixture(async f => {
  await f.loop.tick(3601); await f.set(7201); let reads = 0;
  f.wire.onRead = () => { if (++reads === 4) { f.wire.current = frame(7201, 2000, 2); f.wire.current.blockHeight++; } };
  await f.loop.tick(7201); const s = await f.members[0].g.snapshot();
  assert.equal(s.state, "paused"); assert.equal(s.events.filter(e => e.kind === "execute").length, 1);
  assert.equal(s.intents[0].fill!.status, "cancelled"); assert.equal(s.intents[1].sent, false);
}));
test("stalled snapshot expiry and RPC outage stop/cancel known pending without secret logs", async () => {
  for (const outage of [false, true]) await fixture(async f => {
    await enter(f); f.wire.failure = outage;
    await f.loop.tick(outage ? 7202 : 7261);
    const s = await f.members[0].g.snapshot(); assert.equal(s.state, "paused"); assert.ok(s.intents.every(i => i.fill?.status === "cancelled"));
    assert.ok(!JSON.stringify((await f.loop.snapshot()).events, (_, n) => typeof n === "bigint" ? n.toString() : n).includes("secret upstream"));
  });
});
test("regressed/same-height conflicting finalized snapshots fail closed", async () => {
  for (const conflict of [false, true]) await fixture(async f => {
    await enter(f);
    f.wire.current = conflict ? frame(7201, 1900) : frame(3601);
    await f.loop.tick(7202);
    assert.equal((await f.members[0].g.snapshot()).state, "paused");
    assert.ok((await f.loop.snapshot()).events.some(e => /unavailable\/conflicting/.test(e.reason)));
  });
});
test("counterparty removal triggers bounded surplus reduction, not a fresh entry", async () => fixture(async f => {
  await enter(f); await fill(f); const m = f.members[0];
  await m.perp.counterpartyClose(7203); f.wire.current = frame(7203); await f.loop.tick(7203);
  const s = await m.g.snapshot(); assert.equal(s.intents.length, 1); assert.equal(s.intents[0].request.reduceOnly, true); assert.equal(s.intents[0].request.leg, "spot");
  await m.spot.fill(s.intents[0].request.id, s.intents[0].request.size, 7204); f.wire.current = frame(7204); await f.loop.tick(7204);
  assert.equal((await m.g.snapshot()).observations!.spot.position, 0n);
  assert.equal((await m.g.snapshot()).state, "settled");
  assert.equal((await f.loop.snapshot()).feedback.entries, 1);
}));
test("shared one-entry/flow budgets prevent multi-strategy depth competition and churn", async () => fixture(async f => {
  await enter(f); const s = await f.loop.snapshot();
  assert.equal(s.feedback.entries, 1); assert.equal(s.feedback.epochGross, 600_000_000n);
  assert.equal((await f.members[1].g.snapshot()).intents.length, 0);
  assert.ok(s.events.some(e => /recursive funding chase/.test(e.reason)));
  await f.set(10_801); await f.loop.tick(10_801);
  assert.equal((await f.members[1].g.snapshot()).intents.length, 0);
  assert.ok((await f.loop.snapshot()).events.some(e => /shared flow\/cost budget/.test(e.reason)));
}, 2, { ...feedback, maxEpochGross: 600_000_000n, maxDailyGross: 600_000_000n }));
test("projected own premium reversion and zero chain response cannot trigger another entry", async () => fixture(async f => {
  await enter(f); await fill(f);
  for (const m of f.members) await m.perp.market({ ...quote("perp", 7203), id: "projected-short-impact", price: 99_000_000n });
  f.wire.current = frame(7203); // unchanged chain index/rate: PAPER has no chain price-setting authority
  await f.loop.tick(7203);
  assert.equal((await f.loop.snapshot()).feedback.entries, 1);
  assert.equal((await f.members[0].g.snapshot()).events.filter(e => e.kind === "execute").length, 2);
  assert.equal((await f.members[1].g.snapshot()).intents.length, 0);
  assert.equal(f.wire.current.snapshot.markets[0].funding_rate_ppm, 2000);
}, 2));
test("missing epochs/reversals reset persistence; no rates are backfilled", async () => fixture(async f => {
  await f.loop.tick(3601);
  await f.set(10_801); await f.loop.tick(10_801); assert.equal((await f.loop.snapshot()).feedback.streak, 1);
  await f.set(14_401, -2000); await f.loop.tick(14_401); assert.equal((await f.loop.snapshot()).feedback.streak, 0);
  await f.set(18_001); await f.loop.tick(18_001);
  assert.equal((await f.members[0].g.snapshot()).intents.length, 0);
}));
test("owner stop survives fresh funding and does not resume unsent orders", async () => fixture(async f => {
  await enter(f); const m = f.members[0]; await m.g.pause("alice.testnet", 7202);
  f.wire.current = frame(7202); await f.loop.tick(7202);
  assert.equal((await m.g.snapshot()).state, "paused"); assert.ok((await m.g.snapshot()).intents.every(i => i.fill?.status === "cancelled"));
  await f.loop.tick(7202); assert.equal((await m.g.snapshot()).events.filter(e => e.kind === "execute").length, 2);
}));
test("feedback policy and registration are immutable and bounded", async () => fixture(async f => {
  for (const patch of [{ entryPpm: 3000n }, { persistenceEpochs: 1 }, { maxParticipationBps: 0n }, { cooldownSeconds: 0 }, { maxEpochGross: -1n }, { unexpected: true }]) assert.throws(() => feedbackHash({ ...feedback, ...patch }));
  await assert.rejects(f.loop.initialize(feedback, { "strategy-0": 1n }), /already initialized/);
  const before = hash((await f.loop.snapshot()).policy);
  await f.loop.tick(3601); assert.equal(hash((await f.loop.snapshot()).policy), before);
}));
test("network-scope RPC delay rechecks wall time instead of reviving an expired snapshot", async () => fixture(async f => {
  const original = Date.now; let clock = 3601;
  Date.now = () => clock * 1000;
  try {
    f.wire.current.scope = "NEAR_TESTNET";
    await f.loop.tick(3601);
    await f.set(7201); f.wire.current.scope = "NEAR_TESTNET"; clock = 7201;
    f.wire.onRead = () => { clock = 7262; }; // reply arrives after both snapshot/oracle freshness have elapsed
    // A Sandbox clock callback must never override public-testnet wall time.
    await new FundingLoop(f.store, f.source, f.members.map(m => m.g), () => 7201).tick(7201);
    assert.equal((await f.members[0].g.snapshot()).intents.length, 0);
    assert.equal((await f.members[0].g.snapshot()).state, "paused");
  } finally { Date.now = original; }
}, 1, { ...feedback, scope: "NEAR_TESTNET" }));
test("unknown receipt after submit failure never becomes permission for another order", async () => fixture(async f => {
  const m = f.members[0]; let submits = 0, visible = false;
  const lost: Adapter = { mode: "PAPER", leg: "spot", quote: n => m.spot.quote(n), observe: n => m.spot.observe(n), lookup: async id => visible ? m.spot.lookup(id) : null, cancel: id => m.spot.cancel(id), submit: async (r, n) => { submits++; await m.spot.submit(r, n); throw Error("timeout"); } };
  const g = new Guardian(m.store, lost, m.perp), loop = new FundingLoop(f.store, f.source, [g]);
  await loop.tick(3601); await f.set(7201); await loop.tick(7201);
  const id = (await g.snapshot()).intents[0].request.id;
  await m.spot.fill(id, 400_000n, 7201); visible = true;
  await loop.tick(7201);
  assert.equal(submits, 1); assert.equal((await g.snapshot()).state, "paused"); assert.equal((await g.snapshot()).intents[1].sent, false);
  assert.equal((await m.spot.lookup(id))!.status, "cancelled");
  assert.equal((await g.snapshot()).observations!.spot.position, 400_000n);
}));
