"use client";
import { useVenue } from "@/features/network/useVenue";
export function NetworkBanner() {
  const { data } = useVenue();
  return <div role="status" className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-b border-[#48331c] bg-[#2a1f11] px-3 py-2 text-center text-xs text-[#ff9440]">
    <strong>NEAR testnet · Test funds only.</strong>
    <span>Isolated bilateral positions; either party can close the pair. PnL is capped by counterparty margin.</span>
    {!data?.ready && <span>{data?.reason || "Checking deployment…"} — new orders disabled.</span>}
  </div>;
}
