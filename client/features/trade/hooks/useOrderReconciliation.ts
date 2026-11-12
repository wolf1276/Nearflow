"use client";
import { useEffect } from "react";
import { useWalletStore } from "@/stores/wallet";
import { useLocalOrders, type TrackedOrder } from "@/stores/orders";
import { apiFetch } from "@/lib/api";
interface ApiOrder {
  owner: string; marketId: number; isLong: boolean; nonce: string; size: string;
  limitPrice: string; reduceOnly: boolean; expiryTs: string; cancelled: boolean;
  filledSize: string; createdAt: number; leverage: number;
}
export function useOrderReconciliation() {
  const address = useWalletStore(s => s.address), connected = useWalletStore(s => s.connected);
  useEffect(() => {
    if (!address || !connected) return;
    let stopped = false, busy = false;
    async function sync() {
      if (busy) return; busy = true;
      try {
        const r = await apiFetch(`/api/orders?address=${encodeURIComponent(address!)}`);
        if (!r.ok) return;
        const rows: ApiOrder[] = await r.json(); if (stopped) return;
        const orders: TrackedOrder[] = rows.reverse().map(o => ({
          owner:o.owner, marketId:o.marketId, isLong:o.isLong, nonce:BigInt(o.nonce), size:BigInt(o.size),
          filledSize:BigInt(o.filledSize), limitPrice:BigInt(o.limitPrice), reduceOnly:o.reduceOnly,
          expiryTs:BigInt(o.expiryTs), addedAt:o.createdAt, leverage:o.leverage,
          status:o.cancelled ? "cancelled" : BigInt(o.filledSize) >= BigInt(o.size) ? "filled" : "pending",
        }));
        useLocalOrders.getState().replaceForOwner(address!, orders);
      } catch { /* Preserve state on RPC failure; never invent cancellation. */ }
      finally { busy = false; }
    }
    void sync(); const timer = setInterval(sync, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [address, connected]);
}
