export type State = "draft" | "quoting" | "opening" | "hedged" | "repairing" | "paused" | "unwinding" | "settled";
const edges: Record<State, readonly State[]> = {
  draft: ["quoting", "paused", "settled"], quoting: ["opening", "paused", "settled"],
  opening: ["hedged", "repairing", "paused", "unwinding"], hedged: ["repairing", "paused", "unwinding"],
  repairing: ["hedged", "paused", "unwinding"], paused: ["unwinding", "settled"],
  unwinding: ["settled", "paused"], settled: [],
};
export function transition(from: State, to: State): State {
  if (from !== to && !edges[from].includes(to)) throw Error(`Invalid transition ${from} -> ${to}`);
  return to;
}
