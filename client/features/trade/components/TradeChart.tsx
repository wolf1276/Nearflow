"use client"

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWalletStore } from '@/stores/wallet'
import { useLocalOrders } from '@/stores/orders'
import { getPositions } from '@/lib/near/contracts'
import { NEARFlowChart } from '@/features/chart/components/NEARFlowChart'
import { priceToHuman, amountToHuman } from '@/lib/format'
import type { MarketConfig } from '@/config'
import type { PositionOverlay, OrderOverlay } from '@/features/chart/types'

interface Props {
  /**
   * The full market config. Previously this took `symbol` plus an optional
   * `marketId` defaulting to 1, so any caller that forgot to pass one silently
   * charted NEAR-PERP's position and orders over another market's candles.
   */
  market: MarketConfig
}

export function TradeChart({ market }: Props) {
  const marketIdNum = market.marketId
  const { address, connected } = useWalletStore()

  const allOrders = useLocalOrders((s) => s.orders)
  const pendingOrders = useMemo(
    () => allOrders.filter((o) => o.marketId === marketIdNum && o.status === 'pending' && o.limitPrice > 0n),
    [allOrders, marketIdNum]
  )

  const { data: allPositions = [] } = useQuery({
    queryKey: ['positions', address],
    queryFn: () => getPositions(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  })

  const rawPos = allPositions.find((p) => p.marketId === marketIdNum)

  // Build position overlay for the chart (entry, liq, mark lines)
  const positionOverlay: PositionOverlay | undefined = (() => {
    if (!rawPos || rawPos.entryPrice <= 0n || rawPos.margin <= 0n) return undefined
    const entryPrice = priceToHuman(rawPos.entryPrice)
    const sizeHuman = amountToHuman(rawPos.size)
    const marginHuman = amountToHuman(rawPos.margin)
    // notional (USD) = size_base × entry_usd  →  leverage = notional / margin_usd
    const notional = sizeHuman * entryPrice
    const leverage = Math.max(1, Math.round(notional / Math.max(marginHuman, 0.0001)))
    const liquidationPrice = priceToHuman(rawPos.liquidationPrice)
    const unrealizedPnl = amountToHuman(rawPos.unrealizedPnl)
    return {
      side: rawPos.isLong ? 'long' : 'short',
      entryPrice,
      liquidationPrice,
      unrealizedPnl,
      leverage,
    } satisfies PositionOverlay
  })()

  // Build order overlays (limit orders only — market orders have no price line)
  const orderOverlays: OrderOverlay[] = pendingOrders.map((o) => ({
    price: priceToHuman(o.limitPrice),
    side: o.isLong ? 'buy' : 'sell',
    size: amountToHuman(o.size),
  }))

  return (
    <div className="h-full min-h-0">
      <NEARFlowChart
        symbol={market.tvSymbol}
        marketSymbol={market.symbol}
        priceDecimals={market.priceDecimals}
        position={positionOverlay}
        orders={orderOverlays}
      />
    </div>
  )
}
