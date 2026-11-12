import { NETWORK } from "@/config";
import { requireAccountId } from "./account";

/** Finalized NEAR JSON views. Never convert token integers through Number. */
export async function view<T>(accountId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
  requireAccountId(accountId);
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  const argsBase64 = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""));
  const response = await fetch(NETWORK.rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ jsonrpc: "2.0", id: "nearflow", method: "query", params: {
      request_type: "call_function", finality: "final", account_id: accountId,
      method_name: methodName, args_base64: argsBase64,
    } }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const data = await response.json();
  if (data.error || data.result?.error) throw new Error(`NEAR view failed: ${JSON.stringify(data.error || data.result.error)}`);
  if (!Array.isArray(data.result?.result)) throw new Error("Malformed NEAR view response");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(data.result.result))) as T;
}
