export const NETWORK_IDS = ["testnet"] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];
export const PRIMARY_NETWORK: NetworkId = "testnet";
export function isNetworkId(value: unknown): value is NetworkId { return value === "testnet"; }
if (process.env.NEXT_PUBLIC_NEAR_NETWORK && process.env.NEXT_PUBLIC_NEAR_NETWORK !== "testnet") {
  throw new Error("NEARFlow supports NEAR testnet only");
}
export interface ContractSet { vault: string; engine: string; oracleAdapter: string; orderGateway: string; }
export interface AssetSet { usdc: string; }
export interface CollateralAsset {
  code: string; contract: string; oracleSymbol: string; settlement: boolean;
  decimals: number; note?: string;
}
export interface NetworkConfig {
  id: NetworkId; label: string; shortLabel: string; rpcUrl: string;
  explorerUrl: string; contracts: ContractSet; assets: AssetSet;
  collateral: readonly CollateralAsset[]; keepersExpected: boolean;
}
const exchange = process.env.NEXT_PUBLIC_NEAR_CONTRACT_ID || "";
const usdc = process.env.NEXT_PUBLIC_NEAR_USDC_ID || "";
export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  testnet: {
    id: "testnet", label: "NEAR Testnet", shortLabel: "Testnet",
    rpcUrl: process.env.NEXT_PUBLIC_NEAR_RPC_URL || "https://rpc.testnet.near.org",
    explorerUrl: "https://testnet.nearblocks.io",
    contracts: {
      vault: exchange, engine: exchange, oracleAdapter: exchange, orderGateway: exchange,
    },
    assets: { usdc },
    collateral: [{ code: "USDC", contract: usdc, decimals: 6, oracleSymbol: "USDC", settlement: true }],
    keepersExpected: Boolean(exchange && usdc),
  },
};
export function getNetworkConfig(id: NetworkId): NetworkConfig { return NETWORKS[id]; }
