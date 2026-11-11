"use client";

import { useNetwork } from "@/features/network/NetworkContext";

/**
 * Navbar badge naming the venue.
 *
 * NEARFlow runs on testnet only, so there is nothing to switch — but traders still
 * need a constant reminder that balances here are test funds. Amber matches
 * the warning hue used on the order ticket.
 */
export function NetworkBadge({ className = "" }: { className?: string }) {
  const { config } = useNetwork();

  return (
    <span
      role="status"
      aria-label={`Connected to ${config.label}`}
      title={`Connected to ${config.label}. Balances are test funds.`}
      className={`flex items-center gap-[6px] rounded-[7px] px-[9px] py-[5px] text-[12px] font-medium ${className}`}
      style={{
        color: "#ff9440",
        background: "rgba(255,148,64,0.12)",
        boxShadow: "inset 0 0 0 1px rgba(255,148,64,0.35)",
      }}
    >
      <span aria-hidden="true" className="h-[6px] w-[6px] shrink-0 rounded-full bg-[#ff9440]" />
      {config.shortLabel}
    </span>
  );
}
