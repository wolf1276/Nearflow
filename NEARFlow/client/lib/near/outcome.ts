export interface TransactionOutcome {
  transaction: { hash: string; signer_id?: string; receiver_id?: string };
  status: unknown;
  receipts_outcome: Array<{ outcome: { status: unknown } }>;
}
export interface PendingAction { receiverId: string; methodName: string; args: Record<string, unknown>; accountId: string; createdAt: number; }
export const PENDING_ACTION_KEY = "nearflow-pending-action-v1";
function failed(status: unknown): boolean { return !!status && typeof status === "object" && "Failure" in status; }
export function validateOutcome(outcome: TransactionOutcome, action: PendingAction): string {
  if (outcome.transaction.signer_id && outcome.transaction.signer_id !== action.accountId) throw new Error("Transaction signer mismatch");
  if (outcome.transaction.receiver_id && outcome.transaction.receiver_id !== action.receiverId) throw new Error("Transaction receiver mismatch");
  if (failed(outcome.status)) throw new Error("NEAR transaction failed");
  if (outcome.receipts_outcome.some(r => failed(r.outcome.status))) throw new Error("A NEAR receipt failed. Refresh balances before retrying; withdrawals may have been restored.");
  if (!outcome.status || typeof outcome.status !== "object" || !("SuccessValue" in outcome.status)) throw new Error("Transaction is not finalized yet");
  const value = (outcome.status as { SuccessValue: string }).SuccessValue;
  let decoded: unknown;
  try { decoded = value ? JSON.parse(atob(value)) : null; } catch { throw new Error("Unexpected contract return value"); }
  if (action.methodName === "ft_transfer_call" && decoded !== action.args.amount) throw new Error("Token transfer was refunded in whole or part. Refresh balances before retrying.");
  if ((action.methodName === "withdraw" || action.methodName === "withdraw_strategy") && decoded !== true) throw new Error("Withdrawal did not complete; refresh the restored vault balance");
  return outcome.transaction.hash;
}
