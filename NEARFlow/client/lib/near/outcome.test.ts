import test from "node:test";
import assert from "node:assert/strict";
import { validateOutcome, type TransactionOutcome, type PendingAction } from "./outcome";
const action: PendingAction = { receiverId: "token.testnet", methodName: "ft_transfer_call", args: { amount: "1000000" }, accountId: "alice.testnet", createdAt: 0 };
const outcome = (value: unknown): TransactionOutcome => ({ transaction: { hash: "hash", signer_id: "alice.testnet", receiver_id: "token.testnet" }, status: { SuccessValue: btoa(JSON.stringify(value)) }, receipts_outcome: [] });
test("only a finalized, fully consumed token transfer confirms a deposit", () => {
  assert.equal(validateOutcome(outcome("1000000"), action), "hash");
  assert.throws(() => validateOutcome(outcome("0"), action), /refunded/);
  assert.throws(() => validateOutcome(outcome("500000"), action), /refunded/);
});
test("receipt failures and recovered withdrawals do not appear confirmed", () => {
  const o = outcome("1000000"); o.receipts_outcome.push({ outcome: { status: { Failure: {} } } });
  assert.throws(() => validateOutcome(o, action), /receipt failed/);
  const withdrawal = { ...action, methodName: "withdraw" };
  assert.throws(() => validateOutcome(outcome(false), withdrawal), /did not complete/);
  assert.equal(validateOutcome(outcome(true), withdrawal), "hash");
});
test("callback rejects another sender, receiver and pending execution", () => {
  const o = outcome("1000000"); o.transaction.signer_id = "bob.testnet"; assert.throws(() => validateOutcome(o, action), /signer/);
  o.transaction.signer_id = "alice.testnet"; o.transaction.receiver_id = "other.testnet"; assert.throws(() => validateOutcome(o, action), /receiver/);
  const pending = outcome("1000000"); pending.status = { SuccessReceiptId: "pending" }; assert.throws(() => validateOutcome(pending, action), /not finalized/);
});
