"use client";
import { CONTRACTS, ASSETS } from "@/config";
import { view } from "./rpc";
import { call } from "./wallet";

export interface RawPosition {
  positionId: bigint; owner: string; marketId: number; size: bigint; entryPrice: bigint;
  margin: bigint; isLong: boolean; lastFundingIndex: bigint;
  unrealizedPnl: bigint; liquidationPrice: bigint; liquidatable: boolean; counterparty: string;
}
export interface RawAccountHealth {
  equity: bigint; usedMargin: bigint; freeCollateral: bigint; healthFactor: bigint; liquidatable: boolean;
}
export interface RawCollateralConfig { oracleSymbol: string; haircutBps: number; active: boolean; }
export const getBalance = async (accountId: string, tokenId = ASSETS.usdc): Promise<bigint> =>
  BigInt(await view<string>(CONTRACTS.vault, "balance_of", { account_id: accountId, token_id: tokenId }));
export const getTokenBalance = async (accountId: string, tokenId = ASSETS.usdc): Promise<bigint> =>
  BigInt(await view<string>(tokenId, "ft_balance_of", { account_id: accountId }));
export async function getCollateralConfig(tokenId: string): Promise<RawCollateralConfig | null> {
  const c = await view<{ oracle_symbol: string; haircut_bps: number; active: boolean } | null>(CONTRACTS.vault, "collateral", { token_id: tokenId });
  return c && { oracleSymbol: c.oracle_symbol, haircutBps: c.haircut_bps, active: c.active };
}
export const getDepositCap = async (tokenId: string): Promise<bigint | null> => {
  const cap = await view<string | null>(CONTRACTS.vault, "deposit_cap", { token_id: tokenId });
  return cap === null ? null : BigInt(cap);
};
export const getTotalDeposited = async (tokenId: string): Promise<bigint> =>
  BigInt(await view<string>(CONTRACTS.vault, "total_deposited", { token_id: tokenId }));
export async function getPositions(accountId: string): Promise<RawPosition[]> {
  const rows = await view<Array<Record<string, string | number | boolean>>>(CONTRACTS.engine, "positions", { account_id: accountId });
  return rows.map(p => ({ positionId: BigInt(p.position_id), owner: String(p.owner), marketId: Number(p.market_id),
    size: BigInt(p.size), entryPrice: BigInt(p.entry_price), margin: BigInt(p.margin),
    isLong: Boolean(p.is_long), lastFundingIndex: BigInt(p.last_funding_index),
    unrealizedPnl: BigInt(p.unrealized_pnl), liquidationPrice: BigInt(p.liquidation_price),
    liquidatable: Boolean(p.liquidatable), counterparty: String(p.counterparty) }));
}
export async function getAccountHealth(accountId: string, tokenId = ASSETS.usdc): Promise<RawAccountHealth> {
  const p = await view<Record<string, string | boolean>>(CONTRACTS.engine, "account_health", { account_id: accountId, token_id: tokenId });
  return { equity: BigInt(p.equity), usedMargin: BigInt(p.initial_margin_required), freeCollateral: BigInt(p.free_collateral),
    healthFactor: BigInt(p.margin_ratio), liquidatable: Boolean(p.liquidatable) };
}
export async function getOpenInterest(marketId: number) {
  const p = await view<{ long: string; short: string }>(CONTRACTS.engine, "open_interest", { market_id: marketId });
  const long = BigInt(p.long), short = BigInt(p.short);
  return { long, short, total: long + short };
}
export const isCancelled = (accountId: string, nonce: bigint) =>
  view<boolean>(CONTRACTS.orderGateway, "is_cancelled", { account_id: accountId, nonce: nonce.toString() });
export const getOrderFilled = async (accountId: string, nonce: bigint) =>
  BigInt(await view<string>(CONTRACTS.orderGateway, "filled", { account_id: accountId, nonce: nonce.toString() }));
export async function deposit(accountId: string, amount: bigint, tokenId = ASSETS.usdc) {
  if (amount <= 0n) throw new Error("Amount must be positive");
  // Register with the vault separately. Its receiver rejects unregistered senders.
  const registration = await view<unknown>(CONTRACTS.vault, "storage_balance_of", { account_id: accountId });
  if (!registration) throw new Error("Register your vault account before depositing");
  return call(tokenId, "ft_transfer_call", { receiver_id: CONTRACTS.vault, amount: amount.toString(), msg: "" }, "1", accountId, "200000000000000");
}
export function withdraw(accountId: string, amount: bigint, tokenId = ASSETS.usdc) {
  if (amount <= 0n) throw new Error("Amount must be positive");
  return call(CONTRACTS.vault, "withdraw", { token_id: tokenId, amount: amount.toString() }, "1", accountId);
}
export function closePosition(accountId: string, positionId: bigint) {
  return call(CONTRACTS.engine, "close_position", { position_id: positionId.toString(), amount: null, min_price: null, max_price: null }, "1", accountId, "200000000000000");
}
export function cancelOrder(accountId: string, nonce: bigint, expiryTs: bigint) {
  return call(CONTRACTS.orderGateway, "cancel_order", { nonce: nonce.toString(), expiry_ts: expiryTs.toString() }, "1", accountId);
}
