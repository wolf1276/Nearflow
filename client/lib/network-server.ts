import type { NetworkId } from "@/config/networks";
export async function networkFromCookies(): Promise<NetworkId> {
  // A single explicit NEAR testnet venue; foreign network cookies cannot repoint it.
  return "testnet";
}
