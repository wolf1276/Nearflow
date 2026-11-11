"use client";

// NEAR-native order parameters. Authorization and matching happen atomically on-chain.

export interface OrderIntent {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;       // i128 in AMOUNT_PRECISION (1e6)
  limitPrice: bigint; // i128 in PRICE_PRECISION (1e18)
  reduceOnly: boolean;
  leverage?: number;
  postOnly?: boolean;
  immediateOrCancel?: boolean;
  nonce: bigint;
  expiryTs: bigint;   // unix seconds
}

// Local candidate nonce; submission also checks the contract's monotonic nonce.
// The chain rejects duplicates across tabs or sessions, including cancelled orders.
let nonceCounter = 0;
let lastNonce = 0n;

export function nextOrderNonce(): bigint {
  const candidate = BigInt(Date.now()) * 1000n + BigInt(nonceCounter++ % 1000);
  lastNonce = candidate > lastNonce ? candidate : lastNonce + 1n;
  return lastNonce;
}

export function buildOrderIntent(params: {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  reduceOnly?: boolean;
  leverage?: number;
  postOnly?: boolean;
  immediateOrCancel?: boolean;
  ttlSeconds?: number;
}): OrderIntent {
  return {
    owner: params.owner,
    marketId: params.marketId,
    isLong: params.isLong,
    size: params.size,
    limitPrice: params.limitPrice,
    reduceOnly: params.reduceOnly ?? false,
    leverage: params.leverage ?? 1,
    postOnly: params.postOnly ?? false,
    immediateOrCancel: params.immediateOrCancel ?? false,
    nonce: nextOrderNonce(),
    expiryTs: BigInt(Math.floor(Date.now() / 1000) + (params.ttlSeconds ?? 300)),
  };
}

export function orderIntentToJson(o: OrderIntent): Record<string, string | number | boolean> {
  return {
    owner: o.owner,
    market_id: o.marketId,
    is_long: o.isLong,
    size: o.size.toString(),
    limit_price: o.limitPrice.toString(),
    reduce_only: o.reduceOnly,
    nonce: o.nonce.toString(),
    expiry_ts: o.expiryTs.toString(),
  };
}
