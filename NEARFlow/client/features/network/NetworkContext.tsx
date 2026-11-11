"use client";
import { createContext, useContext } from "react";
import { getNetworkConfig, type NetworkConfig, type NetworkId } from "@/config";
const NetworkContext = createContext<{ network: NetworkId; config: NetworkConfig } | null>(null);
export function NetworkProvider({ network, children }: { network: NetworkId; children: React.ReactNode }) {
  return <NetworkContext.Provider value={{ network, config: getNetworkConfig(network) }}>{children}</NetworkContext.Provider>;
}
export function useNetwork() {
  const value = useContext(NetworkContext);
  if (!value) throw new Error("NetworkProvider is required");
  return value;
}
