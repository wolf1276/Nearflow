import { requireAccountId } from "../../client/lib/near/account";
import { fundingView } from "../../client/lib/near/funding";
import type { FundingSnapshot } from "../../client/lib/near/types";
import { hash } from "../../packages/vault/store";

export interface FinalizedRead {
  scope: "LOCAL_FIXTURE" | "LOCAL_SANDBOX" | "NEAR_TESTNET"; contract: string; finality: "final";
  blockHeight: number; blockHash: string; snapshot: FundingSnapshot;
}
export interface FundingSource { read(): Promise<FinalizedRead>; }
export interface Signal {
  scope: FinalizedRead["scope"]; contract: string; blockHeight: number; blockHash: string;
  snapshotHash: string; at: number; observedAt: number; marketId: number; symbol: string; epoch: number;
  revision: number; mode: "BASELINE" | "ADAPTIVE"; ppm: bigint; storedPpm: bigint;
  indexPrice: bigint; matchedOpenInterest: bigint; rateAppliedAt: number;
  expires: number; usable: boolean; inactiveReason: string | null; binding: string;
}
const integer = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;
const uint = (n: unknown, max: bigint): n is string => typeof n === "string" && /^(0|[1-9][0-9]{0,38})$/.test(n) && BigInt(n) <= max;
const record = (n: unknown): n is Record<string, unknown> => !!n && typeof n === "object" && !Array.isArray(n);

/** Validate RPC data before reusing the same freshness/expiry math as Trade. */
export function signalFrom(read: FinalizedRead, contract: string, marketId: number, now: number): Signal {
  if (!integer(now) || !integer(marketId, 0xffff_ffff) || marketId === 0 || read.contract !== contract || read.finality !== "final" || !["LOCAL_FIXTURE", "LOCAL_SANDBOX", "NEAR_TESTNET"].includes(read.scope)
    || !integer(read.blockHeight) || read.blockHeight === 0 || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(read.blockHash)) throw Error("Invalid finalized snapshot envelope");
  const raw: unknown = read.snapshot;
  if (!record(raw) || !integer(raw.timestamp) || raw.timestamp > now || now - raw.timestamp > 60 || !record(raw.status)
    || raw.status.network !== "testnet" || typeof raw.status.paused !== "boolean" || !Array.isArray(raw.markets) || raw.markets.length > 8 || raw.status.market_count !== raw.markets.length) throw Error("Stale/malformed funding snapshot");
  const ids = new Set<number>();
  for (const m of raw.markets) {
    if (!record(m) || !integer(m.market_id, 0xffff_ffff) || m.market_id === 0 || ids.has(m.market_id) || typeof m.symbol !== "string" || !/^[A-Z0-9]{1,12}$/.test(m.symbol)
      || !uint(m.price, 10n ** 27n) || !uint(m.open_interest, 10n ** 15n) || !integer(m.timestamp) || typeof m.paused !== "boolean" || !record(m.controller)
      || typeof m.funding_rate_ppm !== "number" || !integer(Math.abs(m.funding_rate_ppm), 2000)
      || !integer(m.controller.revision, 0xffff_ffff) || m.controller.revision === 0 || !["BASELINE", "ADAPTIVE"].includes(String(m.controller.mode)) || typeof m.controller.fallback !== "boolean"
      || !(m.controller.last_epoch === null || integer(m.controller.last_epoch)) || !integer(m.controller.rate_applied_at) || !record(m.controller.params)
      || !integer(m.controller.params.oracle_max_age_sec, 60) || m.controller.params.oracle_max_age_sec === 0) throw Error("Malformed funding market");
    ids.add(m.market_id);
  }
  const s = read.snapshot;
  const m = s.markets.find(m => m.market_id === marketId);
  if (!m?.controller) throw Error("Configured funding market missing");
  const epoch = Math.floor(s.timestamp / 3600), view = fundingView(m, s.timestamp, now);
  const inactiveReason = s.status.paused || m.paused ? "VENUE_PAUSED" : m.controller.last_epoch !== epoch || Math.floor(m.controller.rate_applied_at / 3600) !== epoch ? "FUNDING_EPOCH_MISMATCH" : view.funding_inactive_reason;
  const indexPrice = BigInt(m.price);
  const binding = hash({ contract, marketId, epoch, revision: m.controller.revision, mode: m.controller.mode, ppm: view.effective_funding_rate_ppm, indexPrice });
  return { scope: read.scope, contract, blockHeight: read.blockHeight, blockHash: read.blockHash, snapshotHash: hash(read.snapshot), at: s.timestamp, observedAt: now, marketId, symbol: m.symbol, epoch,
    revision: m.controller.revision, mode: m.controller.mode, ppm: inactiveReason ? 0n : BigInt(view.effective_funding_rate_ppm), storedPpm: BigInt(m.funding_rate_ppm!), indexPrice,
    matchedOpenInterest: BigInt(m.open_interest), rateAppliedAt: m.controller.rate_applied_at,
    expires: view.funding_expires_at ?? now, usable: inactiveReason === null && indexPrice >= 10n ** 12n, inactiveReason: indexPrice < 10n ** 12n ? "UNSUPPORTED_MICRO_PRICE" : inactiveReason, binding };
}

/** Read-only JSON-RPC; no signer/key loading, keeper action or funding override. */
export function finalizedSource(rpc: string, contract: string, scope: Exclude<FinalizedRead["scope"], "LOCAL_FIXTURE">, request: typeof fetch = fetch): FundingSource {
  requireAccountId(contract);
  if (!["LOCAL_SANDBOX", "NEAR_TESTNET"].includes(scope)) throw Error("RPC source requires an explicit network scope");
  if (!contract.endsWith(".testnet")) throw Error("Fresh explicit testnet exchange required");
  const url = new URL(rpc);
  if (url.username || url.password || url.search || url.hash || (scope === "LOCAL_SANDBOX" ? url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) : url.protocol !== "https:")) throw Error("Invalid funding RPC URL/scope");
  return { async read() {
    const response = await request(url, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: "paper-funding", method: "query", params: { request_type: "call_function", finality: "final", account_id: contract, method_name: "funding_snapshot", args_base64: "e30=" } }) });
    if (!response.ok) throw Error("Funding snapshot RPC unavailable");
    if (!response.body) throw Error("Missing funding snapshot response");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 1_000_000) { await reader.cancel(); throw Error("Funding snapshot response too large"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!record(data) || data.error || !record(data.result) || data.result.error || !Array.isArray(data.result.result) || data.result.result.length > 262_144 || !data.result.result.every(n => integer(n, 255))
      || !integer(data.result.block_height) || typeof data.result.block_hash !== "string") throw Error("Malformed finalized funding RPC response");
    return { scope, contract, finality: "final", blockHeight: data.result.block_height, blockHash: data.result.block_hash,
      snapshot: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(data.result.result))) as FundingSnapshot };
  } };
}
