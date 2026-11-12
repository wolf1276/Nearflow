import { type Fill, type Observation } from "../adapters/types";
import { policyHash, type Policy } from "../risk/policy";
import { replay, type DecisionEvent } from "./events";
import { evaluate, type Opportunity } from "./opportunity";
import { hash } from "./store";

/** Recompute economics and cumulative receipt accounting, not just log hashes. */
export function replayDecisions(events: DecisionEvent[], policy: Policy) {
  const digest = replay(events), expected = policyHash(policy);
  const receipts = new Map<string, Fill>();
  let costs = 0n, observedCosts = 0n, evaluated = 0;
  for (const e of events) {
    if (e.policyHash !== expected || e.policyRevision !== policy.revision || e.strategy !== policy.strategy || e.mode !== "PAPER") throw Error("Replay policy mismatch");
    if (e.kind === "proposal" || e.kind === "skip") {
      if (hash(evaluate(policy, e.input as Opportunity, e.at)) !== hash(e.result)) throw Error("Economic decision replay mismatch");
      evaluated++;
    }
    if (e.kind === "observe") {
      const o = e.input as { spot: Observation; perp: Observation };
      const total = o.spot.costs + o.perp.costs;
      if (total < observedCosts || total < costs) throw Error("Observed cost replay mismatch");
      observedCosts = total;
    }
    if (e.kind === "receipt") {
      const f = e.result as Fill, previous = receipts.get(f.id);
      if (previous && (f.filled < previous.filled || f.revision <= previous.revision || f.costs < previous.costs)) throw Error("Receipt replay mismatch");
      costs += f.costs - (previous?.costs ?? 0n); receipts.set(f.id, f);
    }
  }
  return { digest, costs: observedCosts, reconciledOrderCosts: costs, evaluated, orders: receipts.size };
}
