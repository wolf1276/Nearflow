"use client";

import { ASSETS, CONTRACTS } from "@/config";
import { requireAccountId } from "./account";
import { view } from "./rpc";
import { call } from "./wallet";
import type { ChainStrategy } from "./types";

type Read = <T>(method: string, args?: Record<string, unknown>) => Promise<T>;
interface Transport { read: Read; send: typeof call }
const gas = "200000000000000";
function unsigned(value: bigint, max: bigint, nonzero = false): string {
  if (value < (nonzero ? 1n : 0n) || value > max) throw new Error("Invalid unsigned strategy amount or ID");
  return value.toString();
}
const id = (value: bigint) => unsigned(value, (1n << 64n) - 1n);
const amount = (value: bigint) => unsigned(value, (1n << 128n) - 1n, true);

/** Owner-signed isolated custody/perp actions. No delegated key or spot API. */
export function createStrategyClient(transport: Transport = {
  read: (method, args) => view(CONTRACTS.engine, method, args), send: call,
}) {
  const get = (strategyId: bigint) => transport.read<ChainStrategy | null>("get_strategy", { strategy_id: id(strategyId) });
  function send(owner: string, method: string, args: Record<string, unknown>, deposit = "1") {
    requireAccountId(owner);
    return transport.send(CONTRACTS.engine, method, args, deposit, owner, gas);
  }
  async function owned(owner: string, strategyId: bigint) {
    requireAccountId(owner);
    const s = await get(strategyId);
    if (!s || s.owner_id !== owner) throw new Error("Strategy owner mismatch or unknown strategy");
    return s;
  }
  return {
    get,
    list(owner: string) {
      requireAccountId(owner);
      return transport.read<ChainStrategy[]>("get_strategies", { owner_id: owner, from_index: 0, limit: 8 });
    },
    async create(owner: string, marketId: number, cap: bigint) {
      requireAccountId(owner);
      if (!Number.isSafeInteger(marketId) || marketId <= 0) throw new Error("Invalid market ID");
      const collateral_cap = amount(cap);
      const cost = await transport.read<string>("strategy_storage_cost");
      return send(owner, "create_strategy", { market_id: marketId, collateral_cap }, amount(BigInt(cost)));
    },
    async deposit(owner: string, strategyId: bigint, value: bigint) {
      const raw = amount(value), strategy_id = id(strategyId);
      const s = await owned(owner, strategyId);
      if (s.paused || s.closed) throw new Error("Strategy not accepting allocation");
      return transport.send(ASSETS.usdc, "ft_transfer_call", {
        receiver_id: CONTRACTS.engine, amount: raw, msg: `strategy:${strategy_id}`,
      }, "1", owner, gas);
    },
    allocate(owner: string, strategyId: bigint, value: bigint) {
      return send(owner, "allocate_strategy", { strategy_id: id(strategyId), amount: amount(value) });
    },
    release(owner: string, strategyId: bigint, value: bigint) {
      return send(owner, "release_strategy", { strategy_id: id(strategyId), amount: amount(value) });
    },
    pause(owner: string, strategyId: bigint, paused: boolean) {
      return send(owner, "set_strategy_paused", { strategy_id: id(strategyId), paused });
    },
    withdraw(owner: string, strategyId: bigint, value: bigint) {
      return send(owner, "withdraw_strategy", { strategy_id: id(strategyId), amount: amount(value) });
    },
    orders(strategyId: bigint) {
      return transport.read<import("./types").ChainOrder[]>("strategy_orders", { strategy_id: id(strategyId) });
    },
    placeOrder(owner: string, strategyId: bigint, order: {
      isLong: boolean; size: bigint; limitPrice: bigint; nonce: bigint; expiry: bigint;
      leverage: number; reduceOnly: boolean; postOnly: boolean; immediateOrCancel: boolean;
    }) {
      if (!Number.isSafeInteger(order.leverage) || order.leverage < 1 || order.leverage > 10) throw new Error("Invalid leverage");
      return send(owner, "place_strategy_order", { strategy_id: id(strategyId), is_long: order.isLong,
        size: amount(order.size), limit_price: amount(order.limitPrice), nonce: id(order.nonce),
        expiry_ts: id(order.expiry), leverage: order.leverage, reduce_only: order.reduceOnly,
        post_only: order.postOnly, immediate_or_cancel: order.immediateOrCancel });
    },
    cancelOrder(owner: string, strategyId: bigint, nonce: bigint) {
      return send(owner, "cancel_strategy_order", { strategy_id: id(strategyId), nonce: id(nonce) });
    },
    closePosition(owner: string, strategyId: bigint, positionId: bigint, size: bigint | null, minPrice: bigint, maxPrice: bigint) {
      if (minPrice > maxPrice) throw new Error("Invalid close price bounds");
      return send(owner, "close_strategy_position", { strategy_id: id(strategyId), position_id: id(positionId),
        amount: size === null ? null : amount(size), min_price: amount(minPrice), max_price: amount(maxPrice) });
    },
    close(owner: string, strategyId: bigint) {
      return send(owner, "close_strategy", { strategy_id: id(strategyId) });
    },
  };
}
