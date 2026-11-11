"use client";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { CONTRACTS, ASSETS } from "@/config";
export function useVenue() {
  return useQuery({
    queryKey: ["venue-ready", CONTRACTS.engine, ASSETS.usdc],
    queryFn: async (): Promise<{ ready: boolean; reason: string }> => {
      if (!CONTRACTS.engine || !ASSETS.usdc) return { ready: false, reason: "Configure a deployed NEARFlow testnet contract and test token" };
      const response = await apiFetch("/api/ready");
      const data = await response.json();
      return { ready: response.ok && data.ready === true, reason: data.ready ? "" : data.paused ? "Venue paused" : data.tokenMatches === false ? "Configured token differs from contract collateral" : "Waiting for fresh oracle prices or NEAR RPC connectivity" };
    }, refetchInterval: 5_000, staleTime: 2_000, retry: 0,
  });
}
