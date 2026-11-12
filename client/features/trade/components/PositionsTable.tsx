"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWalletStore } from "@/stores/wallet";
import { useMarketStore } from "@/stores/market";
import { getPositions, closePosition, RawPosition } from "@/lib/near/contracts";
import { MARKETS } from "@/config";
import { priceToHuman, amountToHuman, formatMarketUsd, formatMarketSize } from "@/lib/format";
import { useTradeSettings } from "@/stores/settings";
import { logoFor, UsdcLogo } from "@/components/common/AssetLogos";
import { toast } from "sonner";
import { useState } from "react";

export function PositionsTable({
  marketFilter,
  sideFilter,
}: {
  marketFilter: number | "all";
  sideFilter: "both" | "long" | "short";
}) {
  const { address, connected } = useWalletStore();
  const markPrices = useMarketStore((s) => s.markPrices);
  const { hidePnl, hideLiqPrice } = useTradeSettings();
  const queryClient = useQueryClient();

  const { data: positions = [] } = useQuery({
    queryKey: ["positions", address],
    queryFn: () => getPositions(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });


  const filtered = positions.filter(
    (p) =>
      (marketFilter === "all" || p.marketId === marketFilter) &&
      (sideFilter === "both" || (sideFilter === "long") === p.isLong)
  );

  if (!connected || !address) {
    return <Empty text="Connect a wallet to view open positions" />;
  }
  if (filtered.length === 0) {
    return <Empty text="No open positions" />;
  }

  const cols = [
    "Market",
    "Size",
    "Entry Price",
    "Mark Price",
    ...(hidePnl ? [] : ["PnL"]),
    ...(hideLiqPrice ? [] : ["Liq. Price"]),
    "Margin",
    "",
  ];

  const makeClose = (pos: RawPosition) => async () => {
    if (!address) return;
    try {
      await closePosition(address, pos.positionId);
      toast.success("Pair closed at the on-chain oracle price");
      for (const key of ["positions", "fills", "balance", "health", "portfolio-analytics"]) {
        void queryClient.invalidateQueries({ queryKey: [key, address] });
      }
    } catch (error) { toast.error(String(error)); }
  };

  return (
    <>
      {/* Desktop: dense table */}
      <table className="hidden w-full text-[12px] tabular lg:table">
        <thead>
          <tr className="text-[10px] text-[#737373] font-semibold uppercase tracking-wider">
            {cols.map((h, i) => (
              <th
                key={h || `act-${i}`}
                className={`py-[9px] whitespace-nowrap ${i === 0 ? "pl-4 pr-2 text-left" : i === cols.length - 1 ? "pr-4 pl-2 text-right" : "px-3 text-right"}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map((pos) => (
            <PositionRow
              key={String(pos.positionId)}
              position={pos}
              markPrice={markPrices[pos.marketId]}
              hidePnl={hidePnl}
              hideLiqPrice={hideLiqPrice}
              onClose={makeClose(pos)}
            />
          ))}
        </tbody>
      </table>

      {/* Mobile: stacked cards */}
      <div className="flex flex-col gap-2 p-3 lg:hidden">
        {filtered.map((pos) => (
          <PositionCard
            key={String(pos.positionId)}
            position={pos}
            markPrice={markPrices[pos.marketId]}
            hidePnl={hidePnl}
            hideLiqPrice={hideLiqPrice}
            onClose={makeClose(pos)}
          />
        ))}
      </div>
    </>
  );
}

interface PositionView {
  baseSymbol: string;
  entryHuman: number;
  sizeHuman: number;
  markHuman: number | null;
  pnlHuman: number | null;
  pnlColor: string;
  pnlPct: number | null;
  positionMargin: number;
  lev: number;
  liqPrice: string | null;
  sideBadge: string;
  isLong: boolean;
  // Pre-formatted at the market's own precision — a shared .toFixed(4) is
  // wrong by four orders of magnitude on BTC and truncates TRX's finest tick.
  sizeDisplay: string;
  entryDisplay: string;
  markDisplay: string;
}

// Shared derivation used by both the desktop row and the mobile card.
function getPositionView(position: RawPosition, markPrice: bigint | undefined): PositionView {
  // MARKETS, not ACTIVE_MARKETS: a position in a de-listed market must still
  // render legibly rather than collapsing to "#7".
  const market = Object.values(MARKETS).find((m) => m.marketId === position.marketId);
  const baseSymbol = market?.baseAsset ?? `#${position.marketId}`;

  const entryHuman = priceToHuman(position.entryPrice);
  const sizeHuman = amountToHuman(position.size);
  const markHuman = markPrice ? priceToHuman(markPrice) : null;
  const refPrice = markHuman ?? entryHuman;

  const pnl = position.unrealizedPnl;
  const pnlHuman = pnl !== null ? amountToHuman(pnl) : null;
  const pnlColor = pnlHuman === null ? "text-[#a3a3a3]" : pnlHuman >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]";

  const notional = sizeHuman * refPrice;
  const positionMargin = amountToHuman(position.margin);
  const pnlPct = pnlHuman !== null && positionMargin > 0 ? (pnlHuman / positionMargin) * 100 : null;
  const lev = positionMargin > 0 ? Math.max(1, Math.round(notional / positionMargin)) : 0;

  const liqPrice = market && position.liquidationPrice > 0n
    ? formatMarketUsd(market, position.liquidationPrice) : null;

  const sideBadge = position.isLong
    ? "bg-[rgba(31,174,91,0.12)] text-[#1fae5b]"
    : "bg-[rgba(227,76,76,0.12)] text-[#e34c4c]";

  // Fall back to 4dp only for an unknown market id — every known market has
  // its own precision.
  const px = (v: number) => (market ? formatMarketUsd(market, v) : "$" + v.toFixed(4));
  const sz = (v: number) => (market ? formatMarketSize(market, v) : v.toFixed(4));

  return {
    baseSymbol, entryHuman, sizeHuman, markHuman, pnlHuman, pnlColor, pnlPct,
    positionMargin, lev, liqPrice, sideBadge, isLong: position.isLong,
    sizeDisplay: sz(sizeHuman),
    entryDisplay: px(entryHuman),
    markDisplay: markHuman !== null ? px(markHuman) : "—",
  };
}

function PnlValue({ v }: { v: PositionView }) {
  if (v.pnlHuman === null) return <>—</>;
  return (
    <>
      {v.pnlHuman >= 0 ? "+" : ""}${Math.abs(v.pnlHuman).toFixed(2)}
      {v.pnlPct !== null && (
        <span className="text-[11px] ml-1">
          ({v.pnlPct >= 0 ? "+" : ""}{v.pnlPct.toFixed(2)}%)
        </span>
      )}
    </>
  );
}

function MarketLabel({ v, badge = true }: { v: PositionView; badge?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {logoFor(v.baseSymbol, 16)}
      <span className="font-semibold text-[#f5f5f5]">
        {v.baseSymbol}
        <span className="text-[#737373] font-normal">/USDC</span>
      </span>
      {badge && (
        <span className={`rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${v.sideBadge}`}>
          {v.lev > 0 ? `${v.lev}× ` : ""}
          {v.isLong ? "LONG" : "SHORT"}
        </span>
      )}
    </div>
  );
}

function PositionRow({
  position,
  markPrice,
  onClose,
  hidePnl,
  hideLiqPrice,
}: {
  position: RawPosition;
  markPrice: bigint | undefined;
  onClose: () => void;
  hidePnl: boolean;
  hideLiqPrice: boolean;
}) {
  const [closing, setClosing] = useState(false);
  const v = getPositionView(position, markPrice);

  return (
    <tr className="border-t border-[#2A2A31] hover:bg-white/[0.02] transition-colors">
      <td className="pl-4 pr-2 py-[10px] text-left">
        <MarketLabel v={v} />
      </td>
      <td className="px-3 py-[10px] text-right">
        <span className={`font-semibold ${v.isLong ? "text-[#1fae5b]" : "text-[#e34c4c]"}`}>
          {v.sizeDisplay}
        </span>{" "}
        <span className="text-[#737373]">{v.baseSymbol}</span>
      </td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">{v.entryDisplay}</td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">
        {v.markDisplay}
      </td>
      {!hidePnl && (
        <td className={`px-3 py-[10px] text-right font-semibold ${v.pnlColor}`}>
          <PnlValue v={v} />
        </td>
      )}
      {!hideLiqPrice && <td className="px-3 py-[10px] text-right text-amber-400">{v.liqPrice ?? "—"}</td>}
      <td className="px-3 py-[10px] text-right text-[#a3a3a3]">
        <span className="inline-flex items-center justify-end gap-1">
          {v.positionMargin.toFixed(2)} <UsdcLogo size={12} />
        </span>
      </td>
      <td className="pr-4 pl-2 py-[10px] text-right">
        <CloseButton closing={closing} setClosing={setClosing} onClose={onClose} />
      </td>
    </tr>
  );
}

function PositionCard({
  position,
  markPrice,
  onClose,
  hidePnl,
  hideLiqPrice,
}: {
  position: RawPosition;
  markPrice: bigint | undefined;
  onClose: () => void;
  hidePnl: boolean;
  hideLiqPrice: boolean;
}) {
  const [closing, setClosing] = useState(false);
  const v = getPositionView(position, markPrice);

  return (
    <div className="rounded-[10px] border border-[#2A2A31] bg-[#212128] p-3">
      <div className="flex items-center justify-between gap-2">
        <MarketLabel v={v} />
        <CloseButton closing={closing} setClosing={setClosing} onClose={onClose} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[12.5px] tabular">
        <Field label="Size">
          <span className={v.isLong ? "text-[#1fae5b]" : "text-[#e34c4c]"}>{v.sizeDisplay}</span>{" "}
          <span className="text-[#737373]">{v.baseSymbol}</span>
        </Field>
        {!hidePnl && (
          <Field label="PnL" align="right">
            <span className={`font-semibold ${v.pnlColor}`}><PnlValue v={v} /></span>
          </Field>
        )}
        <Field label="Entry">
          <span className="text-[#f5f5f5]">{v.entryDisplay}</span>
        </Field>
        <Field label="Mark" align="right">
          <span className="text-[#f5f5f5]">{v.markDisplay}</span>
        </Field>
        {!hideLiqPrice && (
          <Field label="Liq. Price">
            <span className="text-amber-400">{v.liqPrice ?? "—"}</span>
          </Field>
        )}
        <Field label="Margin" align={hideLiqPrice ? "left" : "right"}>
          <span className="inline-flex items-center gap-1 text-[#a3a3a3]">
            {v.positionMargin.toFixed(2)} <UsdcLogo size={12} />
          </span>
        </Field>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  align = "left",
}: {
  label: string;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div className={`flex flex-col gap-0.5 ${align === "right" ? "items-end text-right" : "items-start"}`}>
      <span className="text-[10px] uppercase tracking-wider text-[#737373]">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}

function CloseButton({
  closing,
  setClosing,
  onClose,
}: {
  closing: boolean;
  setClosing: (v: boolean) => void;
  onClose: () => void;
}) {
  return (
    <button
      className="shrink-0 rounded-[6px] border border-[#334155] px-3 py-1.5 text-[12px] font-semibold text-[#f5f5f5] transition-colors hover:border-[#475569] hover:bg-[#212128] disabled:opacity-50"
      disabled={closing}
      onClick={async () => {
        setClosing(true);
        await onClose();
        setClosing(false);
      }}
    >
      {closing ? "Closing…" : "Close"}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-[#a3a3a3]">
      <span className="text-[13px] text-[#a3a3a3]">{text}</span>
    </div>
  );
}
