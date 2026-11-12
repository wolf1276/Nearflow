import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PaperAdapter } from "../../packages/adapters/paper";
import { type Quote } from "../../packages/adapters/types";
import { type Policy } from "../../packages/risk/policy";
import { type Opportunity } from "../../packages/vault/opportunity";
import { replayDecisions } from "../../packages/vault/replay";
import { encode, Store } from "../../packages/vault/store";
import { Guardian, type Journal } from "./guardian";

// Internal CLI only. No RPC, signer, wallet, token deposit or HTTP mutation path.
async function main() {
  const dir = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), "reflex-paper-"));
  const p: Policy = { version: 1, revision: 1, owner: "paper-owner.testnet", strategy: "paper-demo", mode: "PAPER", autoOpen: true, autoReduce: true, autoClose: true, maxGross: 300_000_000n, maxDelta: 1_000_000n, maxDeltaSeconds: 60, minReserve: 1_000_000n, minMarginBps: 1000n, maxSlippageBps: 20n, maxDailyTurnover: 1_000_000_000n, minNetCarry: 1n, maxActionCost: 1_000_000n, maxTotalCost: 10_000_000n, cooldownSeconds: 0, maxRetries: 3, maxParticipationBps: 5000n };
  const q = (leg: "spot" | "perp"): Quote => ({ mode: "PAPER", leg, market: "NEAR/USD", id: `${leg}-fixture-1`, at: 100, expires: 1000, price: 100_000_000n, depth: 10_000_000n, feeBps: 3n, slippageBps: 2n, available: true });
  const spot = new PaperAdapter("spot", new Store(join(dir, "spot.json")));
  const perp = new PaperAdapter("perp", new Store(join(dir, "perp.json")));
  await spot.initialize(p.strategy, 500_000_000n, q("spot"));
  await perp.initialize(p.strategy, 500_000_000n, q("perp"), 100_000_000n);
  const g = new Guardian(new Store<Journal>(join(dir, "guardian.json")), spot, perp);
  await g.create(p, p.owner);
  const o: Opportunity = { at: 100, epoch: 1, configRevision: 1, fundingPpm: 2000n, horizonSeconds: 14_400, collectibleSeconds: 14_400, payerCollateral: 0n, basisChange: 0n, repairCost: 10_000n, reserveCost: 10_000n, exitCost: 100_000n, spotCash: 0n, perpCash: 0n, size: 1_000_000n, spot: q("spot"), perp: q("perp") };
  if (await g.propose({ ...o, fundingPpm: 1n }, 100)) throw Error("Expected net-negative skip");
  if (!await g.propose({ ...o, epoch: 2 }, 100)) throw Error("Expected eligible PAPER hedge");
  for (const i of (await g.snapshot()).intents) {
    await g.dispatch(i.request.id, 100);
    await (i.request.leg === "spot" ? spot : perp).fill(i.request.id, i.request.size, 100);
    await g.reconcile(100);
  }
  const hedged = (await g.snapshot()).state;
  await perp.counterpartyClose(101); await g.reconcile(101);
  await g.repair(101);
  for (const i of (await g.snapshot()).intents) {
    await g.dispatch(i.request.id, 101); await spot.fill(i.request.id, i.request.size, 101);
  }
  await g.reconcile(101); await g.reduce(101, p.owner);
  const final = await g.snapshot();
  if (hedged !== "hedged" || final.state !== "settled") throw Error("Unexpected PAPER lifecycle");
  console.log(encode({ mode: "PAPER", custody: "Independent virtual ledgers; no exchange balances credited", directory: dir, hedged, final: final.state, legs: final.observations, audit: replayDecisions(final.events, p), totalCosts: final.costs, note: "No realized funding was injected; this fixture loses execution costs. Expected carry is not a return." }));
}
main().catch(() => { console.error("PAPER fixture failed; inspect local journal, never reset existing state blindly"); process.exitCode = 1; });
