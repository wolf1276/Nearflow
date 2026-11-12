"use client";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { NETWORK, EXPLORER_URL } from "@/config";
import { getWalletAccount } from "@/lib/near/wallet";
import { PENDING_ACTION_KEY, validateOutcome, type PendingAction, type TransactionOutcome } from "@/lib/near/outcome";

export function WalletCallback() {
  const client = useQueryClient();
  useEffect(() => {
    const url = new URL(window.location.href);
    const hashes = url.searchParams.get("transactionHashes"), rejected = url.searchParams.get("errorCode");
    if (!hashes && !rejected) return;
    let stopped = false;
    function clean() {
      for (const key of ["transactionHashes", "errorCode", "errorMessage"]) url.searchParams.delete(key);
      window.history.replaceState({}, "", url.toString()); localStorage.removeItem(PENDING_ACTION_KEY);
    }
    async function confirm() {
      try {
        const saved = localStorage.getItem(PENDING_ACTION_KEY);
        if (!saved) throw new Error("No pending NEARFlow transaction to confirm; refresh your account");
        const action = JSON.parse(saved) as PendingAction;
        if (Date.now() - action.createdAt > 900000) throw new Error("Transaction confirmation expired; check your account on NEARBlocks");
        if (rejected) throw new Error("Wallet rejected or cancelled the transaction");
        const account = await getWalletAccount();
        if (account !== action.accountId) throw new Error("Connected account differs from the pending transaction");
        const hash = hashes!.split(",")[0];
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(hash)) throw new Error("Invalid NEAR transaction hash");
        let outcome: TransactionOutcome | undefined;
        for (let attempt = 0; attempt < 15 && !stopped; attempt++) {
          const r = await fetch(NETWORK.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: "nearflow-confirm", method: "tx", params: { tx_hash: hash, sender_account_id: account, wait_until: "FINAL" } }),
            signal: AbortSignal.timeout(10000),
          });
          const data = await r.json();
          if (r.ok && data.result?.status && typeof data.result.status === "object") { outcome = data.result; break; }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        if (stopped) return;
        if (!outcome) throw new Error("Confirmation timed out. Do not resubmit before checking the chain.");
        validateOutcome(outcome, action);
        toast.success(`${action.methodName} confirmed on NEAR`, { action: { label: "Explorer", onClick: () => window.open(`${EXPLORER_URL}/txns/${hash}`, "_blank", "noopener") } });
      } catch (error) { if (!stopped) toast.error(String(error)); }
      finally { if (!stopped) { clean(); void client.invalidateQueries(); } }
    }
    void confirm(); return () => { stopped = true; };
  }, [client]);
  return null;
}
