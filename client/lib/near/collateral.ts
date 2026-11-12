import { COLLATERAL, CONTRACTS, type CollateralAsset } from "@/config";
import { getCollateralConfig, getDepositCap, getTotalDeposited } from "./contracts";
import { view } from "./rpc";
import { call } from "./wallet";
export interface ListedCollateral extends CollateralAsset {
  haircutBps: number; depositCap: bigint | null; totalDeposited: bigint; capHeadroom: bigint | null;
}
export async function listVaultCollateral(): Promise<ListedCollateral[]> {
  const rows = await Promise.all(COLLATERAL.filter(a => a.contract).map(async a => {
    const config = await getCollateralConfig(a.contract);
    if (!config?.active) return null;
    const [depositCap, totalDeposited] = await Promise.all([getDepositCap(a.contract), getTotalDeposited(a.contract)]);
    return { ...a, haircutBps: config.haircutBps, depositCap, totalDeposited,
      capHeadroom: depositCap === null ? null : depositCap > totalDeposited ? depositCap - totalDeposited : 0n };
  }));
  return rows.filter((a): a is ListedCollateral => a !== null);
}
export async function hasStorageRegistration(accountId: string, asset: CollateralAsset): Promise<boolean> {
  const [vault, token] = await Promise.all([
    view<unknown>(CONTRACTS.vault, "storage_balance_of", { account_id: accountId }),
    view<unknown>(asset.contract, "storage_balance_of", { account_id: accountId }),
  ]);
  return !!vault && !!token;
}
/** Register one missing account at a time; web wallets may redirect after each call. */
export async function registerStorage(accountId: string, asset: CollateralAsset): Promise<string> {
  for (const contract of [asset.contract, CONTRACTS.vault]) {
    const registered = await view<unknown>(contract, "storage_balance_of", { account_id: accountId });
    if (registered) continue;
    const bounds = await view<{ min: string }>(contract, "storage_balance_bounds");
    const result = await call(contract, "storage_deposit", { account_id: accountId, registration_only: true }, bounds.min, accountId);
    return result.hash;
  }
  throw new Error("Storage already registered");
}
export function roundToBridgeable(raw: bigint, asset: CollateralAsset): bigint {
  if (asset.decimals !== 6) throw new Error("Unsupported collateral precision");
  return raw;
}
