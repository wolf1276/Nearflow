export interface ExecutionReadiness {
  mode: "PAPER" | "NEAR_TESTNET" | "SPOT_REAL";
  enabled: boolean;
  blockers: readonly string[];
}
export function executionReadiness(mode: ExecutionReadiness["mode"]): ExecutionReadiness {
  if (mode === "PAPER") return { mode, enabled: true, blockers: [] };
  return { mode, enabled: false, blockers: [
    "Separate explicit real-trading approval required",
    "Contract-enforced delegated policy authority not implemented/reviewed",
    "Genuine spot venue custody, liquidity and finality not selected/approved",
    "S1–S3 runtime/security and D1 dedicated funded deployment gates incomplete",
    "Signed two-leg receipts, balances and restart evidence absent",
  ] };
}
export function requirePaper(mode: ExecutionReadiness["mode"]) {
  if (mode !== "PAPER") throw Error(`Real execution disabled: ${executionReadiness(mode).blockers.join("; ")}`);
}
