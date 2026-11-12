"use client";

import { useEffect } from "react";
import { useWalletStore } from "@/stores/wallet";
import {
  connectWallet,
  disconnectWallet,
  getWalletAccount,
  walletAvailable,
  isOnExpectedNetwork,
} from "@/lib/near/wallet";
import { shortenAddress } from "@/lib/format";
import { toast } from "sonner";
import { NETWORK_LABEL } from "@/config";

export function WalletConnect() {
  const {
    address,
    connected,
    connecting,
    wrongNetwork,
    setAddress,
    setConnected,
    setConnecting,
    setWrongNetwork,
    disconnect,
  } = useWalletStore();

  useEffect(() => {
    let cancelled = false;
    async function refreshWalletState() {
      const addr = await getWalletAccount();
      if (cancelled) return;
      if (addr) {
        setAddress(addr);
        setConnected(true);
        const ok = await isOnExpectedNetwork();
        if (!cancelled) setWrongNetwork(!ok);
      } else {
        setAddress(null);
        setConnected(false);
        setWrongNetwork(false);
      }
    }

    void refreshWalletState().catch(() => {});
    const id = setInterval(() => { void refreshWalletState().catch(() => {}); }, 3_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [setAddress, setConnected, setWrongNetwork]);

  async function handleConnect() {
    const installed = await walletAvailable();
    if (!installed) {
      toast.error("NEAR wallet could not be opened. Please try again.");
      return;
    }
    setConnecting(true);
    try {
      const addr = await connectWallet();
      setAddress(addr);
      setConnected(true);
      const ok = await isOnExpectedNetwork();
      setWrongNetwork(!ok);
      if (!ok) toast.warning(`Switch NEAR wallet to ${NETWORK_LABEL}.`);
      else toast.success("Wallet connected");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setConnecting(false);
    }
  }

  if (!connected) {
    return (
      <button
        onClick={handleConnect}
        disabled={connecting}
        className="shrink-0 whitespace-nowrap rounded-[8px] px-3 py-2 text-[12.5px] font-semibold text-[#19191A] transition-opacity disabled:opacity-50 sm:px-[18px] sm:py-[10px] sm:text-[13.5px]"
        style={{
          background: "#f5f5f5",
          letterSpacing: ".01em",
        }}
        onMouseOver={(e) => (e.currentTarget.style.background = "#e5e7eb")}
        onMouseOut={(e) => (e.currentTarget.style.background = "#f5f5f5")}
      >
        {connecting ? "Connecting…" : "Connect Wallet"}
      </button>
    );
  }

  async function handleDisconnect() {
    try {
      await disconnectWallet();
      disconnect();
      toast.success("Wallet disconnected");
    } catch (error) { toast.error(String(error)); }
  }

  return (
    <div className="flex items-center gap-1.5">
      {wrongNetwork && (
        <span className="hidden text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded font-semibold sm:inline">
          Wrong network
        </span>
      )}
      <button
        onClick={handleDisconnect}
        title={wrongNetwork ? "Wrong network — click to disconnect" : "Click to disconnect"}
        className={`flex shrink-0 items-center rounded-[7px] border bg-[#212128] px-3 py-2 transition-colors group sm:px-[18px] sm:py-[8px] ${
          wrongNetwork ? "border-amber-500/40" : "border-[#2A2A31] hover:border-red-500/40 hover:bg-red-500/5"
        }`}
      >
        {wrongNetwork && (
          <span className="mr-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 sm:hidden" />
        )}
        <span className="font-mono text-[12.5px] text-[#f5f5f5] group-hover:text-red-400 transition-colors sm:text-[14px]">
          {shortenAddress(address!)}
        </span>
      </button>
    </div>
  );
}
