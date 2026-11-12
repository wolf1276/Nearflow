"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { CONTRACTS, ASSETS } from "@/config";
interface Readiness { ready: boolean; reason: string; readyUntil?: number; asOf?: number }
export function useVenue() {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const update = () => setNow(Math.floor(Date.now() / 1000));
    update(); const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ["venue-ready", CONTRACTS.engine, ASSETS.usdc],
    queryFn: async ({ signal }): Promise<Readiness> => {
      if (!CONTRACTS.engine || !ASSETS.usdc) return { ready: false, reason: "Configure a deployed NEARFlow testnet contract and test token" };
      const response = await apiFetch("/api/ready", { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      const data = await response.json();
      return { ready: response.ok && data.ready === true, readyUntil: data.readyUntil, asOf: data.asOf,
        reason: data.ready ? "" : data.paused ? "Venue paused" : data.tokenMatches === false ? "Configured token differs from contract collateral" : "Waiting for fresh oracle prices or NEAR RPC connectivity" };
    }, refetchInterval: 5000, staleTime: 2000, retry: 0,
  });
  let data = query.data;
  if (query.isError) data = { ready: false, reason: "NEAR RPC unavailable" };
  else if (data?.ready && (!now || !Number.isSafeInteger(data.readyUntil) || !Number.isSafeInteger(data.asOf)
    || now < data.asOf! || now > data.readyUntil!)) data = { ready: false, reason: "Oracle readiness expired; waiting for fresh confirmation" };
  return { ...query, data };
}
