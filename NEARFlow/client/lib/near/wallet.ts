"use client";

import { Buffer } from "buffer";
import type { BrowserWallet, WalletSelector } from "@near-wallet-selector/core";
import { CONTRACTS, NETWORK } from "@/config";
import { requireAccountId } from "./account";
import { validateOutcome, PENDING_ACTION_KEY, type PendingAction } from "./outcome";

let selectorPromise: Promise<WalletSelector> | undefined;
export function getSelector(): Promise<WalletSelector> {
  if (typeof window === "undefined") throw new Error("Wallet requires a browser");
  // The wallet SDK serializes native NEAR actions through browser Buffer APIs.
  (globalThis as unknown as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
  if (!selectorPromise) {
    selectorPromise = Promise.all([
      import("@near-wallet-selector/core"), import("@near-wallet-selector/my-near-wallet"),
    ]).then(([{ setupWalletSelector }, { setupMyNearWallet }]) => setupWalletSelector({
      network: { networkId: "testnet", nodeUrl: NETWORK.rpcUrl,
        helperUrl: "https://helper.testnet.near.org", explorerUrl: "https://testnet.nearblocks.io", indexerUrl: "https://api-testnet.nearblocks.io" },
      modules: [setupMyNearWallet()],
    })).catch(error => { selectorPromise = undefined; throw error; });
  }
  return selectorPromise;
}
export async function walletAvailable(): Promise<boolean> { return typeof window !== "undefined"; }
export async function getWalletAccount(): Promise<string | null> {
  const selector = await getSelector();
  return selector.store.getState().accounts.find(a => a.active)?.accountId ?? null;
}
export async function connectWallet(): Promise<string> {
  const selector = await getSelector();
  const existing = await getWalletAccount();
  if (existing) return existing;
  requireAccountId(CONTRACTS.vault);
  // Web wallet may navigate away. Do not resolve with a fabricated account.
  const wallet = await selector.wallet<BrowserWallet>("my-near-wallet");
  const accounts = await wallet.signIn({ contractId: CONTRACTS.vault });
  const accountId = accounts[0]?.accountId;
  if (!accountId) throw new Error("Complete sign-in in your NEAR wallet");
  return accountId;
}
export async function disconnectWallet(): Promise<void> {
  const selector = await getSelector();
  if (selector.isSignedIn()) await (await selector.wallet()).signOut();
}
export async function isOnExpectedNetwork(): Promise<boolean> {
  const selector = await getSelector();
  return selector.options.network.networkId === "testnet" && !!(await getWalletAccount());
}
export async function call(receiverId: string, methodName: string, args: Record<string, unknown>,
  deposit = "0", owner?: string, gas = "100000000000000"): Promise<{ hash: string }> {
  requireAccountId(receiverId);
  const selector = await getSelector();
  const account = await getWalletAccount();
  if (!account || (owner && account !== owner)) throw new Error("Connected NEAR account does not match the action owner");
  const action: PendingAction = { receiverId, methodName, args, accountId: account, createdAt: Date.now() };
  localStorage.setItem(PENDING_ACTION_KEY, JSON.stringify(action));
  try {
    const { actionCreators } = await import("@near-wallet-selector/core");
    const outcome = await (await selector.wallet()).signAndSendTransaction({
      signerId: account, receiverId,
      actions: [actionCreators.functionCall(methodName, new TextEncoder().encode(JSON.stringify(args)), BigInt(gas), BigInt(deposit))],
    });
    if (!outcome) throw new Error("Transaction redirected to wallet; confirmation is pending");
    const hash = validateOutcome(outcome, action);
    localStorage.removeItem(PENDING_ACTION_KEY);
    return { hash };
  } catch (error) {
    // Redirect wallets unload the page. A returned rejection is not confirmation.
    throw error;
  }
}
