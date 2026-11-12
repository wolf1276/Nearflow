import { getNetworkConfig, PRIMARY_NETWORK, type NetworkId } from "./networks";
export { NETWORKS, NETWORK_IDS, PRIMARY_NETWORK, getNetworkConfig, isNetworkId } from "./networks";
export type { NetworkId, NetworkConfig, ContractSet, AssetSet, CollateralAsset } from "./networks";
export const ACTIVE_NETWORK_ID: NetworkId = PRIMARY_NETWORK;
const active = getNetworkConfig(ACTIVE_NETWORK_ID);
export const NETWORK = { name: active.id, rpcUrl: active.rpcUrl };
export const CONTRACTS = active.contracts;
export const ASSETS = active.assets;
export const COLLATERAL = active.collateral;
export const SETTLEMENT_ASSET = COLLATERAL[0];
export const PRICE_PRECISION = 10n ** 18n;
export const AMOUNT_PRECISION = 10n ** 6n;
export const BPS_PRECISION = 10000;
export const EXPLORER_URL = active.explorerUrl;
export const NETWORK_LABEL = active.label;
export interface MarketConfig {
  marketId: number; symbol: string; displayName: string; baseAsset: string; quoteAsset: string;
  oracleSymbol: string; priceSourceSymbol: string; settlementAsset: string; tvSymbol: string;
  maxLeverageBps: number; initialMarginBps: number; maintenanceMarginBps: number; liquidationFeeBps: number;
  priceDecimals: number; sizeDecimals: number; tickSizes: number[]; maxOpenInterestBase: number; maxOpenInterestUsd: number;
}
const definitions: Array<[string, number, number, number[], number, number]> = [
  ["NEAR", 4, 4, [0.0001, 0.001, 0.01, 0.1], 5000, 1000],
  ["BTC", 1, 4, [0.1, 1, 10, 100], 1, 1000],
  ["ETH", 2, 3, [0.01, 0.1, 1, 10], 5, 1000],
  ["SOL", 2, 3, [0.01, 0.1, 1, 5], 100, 1000],
  ["XRP", 4, 1, [0.0001, 0.001, 0.01, 0.1], 5000, 1000],
  ["ADA", 4, 1, [0.0001, 0.001, 0.01, 0.1], 10000, 2000],
  ["BNB", 2, 3, [0.01, 0.1, 1, 5], 5, 1000],
  ["TRX", 5, 0, [0.00001, 0.0001, 0.001, 0.01], 20000, 2000],
];
export const MARKETS: Record<string, MarketConfig> = Object.fromEntries(definitions.map(([base, priceDecimals, sizeDecimals, tickSizes, maxOpenInterestBase, initialMarginBps], i) => {
  const symbol = `${base}-PERP`;
  return [symbol, { marketId: i + 1, symbol, displayName: symbol, baseAsset: base, quoteAsset: "USDC", oracleSymbol: base,
    priceSourceSymbol: `${base}USDT`, settlementAsset: ASSETS.usdc, tvSymbol: `BINANCE:${base}USDT`,
    maxLeverageBps: Math.floor(10000 / initialMarginBps) * 10000, initialMarginBps, maintenanceMarginBps: initialMarginBps / 2,
    liquidationFeeBps: 50, priceDecimals, sizeDecimals, tickSizes, maxOpenInterestBase, maxOpenInterestUsd: 10000 }];
}));
export const ACTIVE_MARKET_SYMBOLS = [...new Set((process.env.NEXT_PUBLIC_ACTIVE_MARKETS || "NEAR-PERP").split(",").map(s => s.trim().toUpperCase()))];
if (!ACTIVE_MARKET_SYMBOLS.length || ACTIVE_MARKET_SYMBOLS.some(s => !MARKETS[s])) throw new Error("Invalid active market configuration");
export const ACTIVE_MARKETS = Object.fromEntries(ACTIVE_MARKET_SYMBOLS.map(s => [s, MARKETS[s]]));
export const DEFAULT_MARKET_SYMBOL = ACTIVE_MARKET_SYMBOLS[0];
