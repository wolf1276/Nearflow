import { hash } from "../vault/store";
export interface Policy {
  version: 1; revision: number; owner: string; strategy: string;
  mode: "PAPER"; autoOpen: boolean; autoReduce: boolean; autoClose: boolean;
  maxGross: bigint; maxDelta: bigint; maxDeltaSeconds: number;
  minReserve: bigint; minMarginBps: bigint; maxSlippageBps: bigint;
  maxDailyTurnover: bigint; minNetCarry: bigint; maxActionCost: bigint;
  maxTotalCost: bigint; cooldownSeconds: number; maxRetries: number; maxParticipationBps: bigint;
}
export function validatePolicy(p: Policy) {
  const keys: (keyof Policy)[] = ["version", "revision", "owner", "strategy", "mode", "autoOpen", "autoReduce", "autoClose", "maxGross", "maxDelta", "maxDeltaSeconds", "minReserve", "minMarginBps", "maxSlippageBps", "maxDailyTurnover", "minNetCarry", "maxActionCost", "maxTotalCost", "cooldownSeconds", "maxRetries", "maxParticipationBps"];
  if (Object.keys(p).length !== keys.length || keys.some(k => !(k in p)) || p.version !== 1 || p.mode !== "PAPER" || !/^[a-z0-9._-]{2,64}$/.test(p.owner) || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.strategy)) throw Error("Invalid policy identity/schema");
  for (const k of ["maxGross", "maxDelta", "minReserve", "minMarginBps", "maxSlippageBps", "maxDailyTurnover", "minNetCarry", "maxActionCost", "maxTotalCost", "maxParticipationBps"] as const) {
    if (typeof p[k] !== "bigint" || p[k] < 0n || p[k] > 10n ** 30n) throw Error(`Invalid policy ${k}`);
  }
  for (const k of ["revision", "maxDeltaSeconds", "cooldownSeconds", "maxRetries"] as const) if (!Number.isSafeInteger(p[k]) || p[k] < 0 || p[k] > 1_000_000) throw Error(`Invalid policy ${k}`);
  for (const k of ["autoOpen", "autoReduce", "autoClose"] as const) if (typeof p[k] !== "boolean") throw Error("Invalid permission");
  if (p.revision < 1 || p.maxGross === 0n || p.minMarginBps < 1000n || p.minMarginBps > 10_000n || p.maxSlippageBps > 10_000n || p.maxParticipationBps === 0n || p.maxParticipationBps > 10_000n || p.maxActionCost > p.maxTotalCost) throw Error("Invalid policy bounds");
}
export function policyHash(p: Policy) {
  validatePolicy(p);
  return hash(Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))));
}
export function ownerOnly(p: Policy, actor: string) { if (p.owner !== actor) throw Error("Owner only"); }
