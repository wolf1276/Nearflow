"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { displayedFunding, fundingBps, type FundingMarket } from "@/lib/near/funding";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const reasons: Record<string, string> = {
  ORACLE_STALE: "Oracle stale or future-dated; not accruing",
  RATE_EXPIRED: "Quote expired; not accruing",
  RATE_UNAVAILABLE: "Application metadata unavailable; not accruing",
  ZERO_FALLBACK: "Zero fallback: missing, stale or divergent mark",
};
export function FundingStatus({ marketId }: { marketId: number }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const update = () => setNow(Math.floor(Date.now() / 1000));
    update(); const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ["funding-quote", marketId],
    queryFn: async ({ signal }): Promise<FundingMarket> => {
      const r = await apiFetch(`/api/markets/${marketId}`, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      if (!r.ok) throw new Error("Funding RPC unavailable");
      return r.json();
    }, refetchInterval: 3000, retry: 0,
  });
  const data = query.isError ? undefined : query.data;
  const effective = data && now ? displayedFunding(data, now) : undefined;
  const state = query.isError ? "RPC unavailable" : !effective ? "Loading…"
    : effective.reason ? (reasons[effective.reason] ?? "Funding inactive") : effective.rate === 0 ? "Zero rate; no transfer" : "Accruing";
  const direction = !effective || effective.reason || effective.rate === 0 ? "No current transfer"
    : effective.rate > 0 ? "Longs pay shorts" : "Shorts pay longs";
  return <Dialog>
    <DialogTrigger aria-label="Funding details" className="flex h-full shrink-0 flex-col justify-center gap-0.5 px-2 text-left text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      <span className="text-muted-foreground">Funding · {data?.controller?.mode ?? "—"}</span>
      <span className="font-mono" role="status">{effective ? fundingBps(effective.rate) : "—"}</span>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Funding details</DialogTitle>
        <DialogDescription>Experimental hourly funding, not APR or promised carry.</DialogDescription>
      </DialogHeader>
      <p role="status">{state}</p>
      {data && effective ? <dl className="grid grid-cols-2 gap-3 text-sm">
        <dt>Mode / revision</dt><dd>{data.controller?.mode ?? "Unknown"} / {data.controller?.revision ?? "—"}</dd>
        <dt>Accruing rate</dt><dd className="font-mono">{fundingBps(effective.rate)}</dd>
        <dt>Stored quote</dt><dd className="font-mono">{fundingBps(data.stored_funding_rate_ppm)} ({data.stored_funding_rate_ppm} ppm)</dd>
        <dt>Payment direction</dt><dd>{direction}</dd>
        <dt>Chain snapshot</dt><dd className="break-all">{new Date(data.funding_as_of * 1000).toISOString()}</dd>
        <dt>Accrual expiry</dt><dd className="break-all">{data.funding_expires_at === null ? "Unavailable" : new Date(data.funding_expires_at * 1000).toISOString()}</dd>
        <dt>Oracle TTL</dt><dd>{data.controller?.params.oracle_max_age_sec ?? 60} seconds</dd>
      </dl> : <p>Funding data unavailable. Check NEAR RPC connectivity; no rate is assumed.</p>}
      <p className="text-sm text-muted-foreground">100 ppm = 1 basis point. Positive quotes charge longs; negative quotes charge shorts. A stored quote can survive an outage without accruing. Zero fallback and configuration resets bypass the usual adaptive slope cap. Payments are capped by payer collateral; either counterparty can close the pair.</p>
    </DialogContent>
  </Dialog>;
}
