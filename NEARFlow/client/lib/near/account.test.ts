import test from "node:test";
import assert from "node:assert/strict";
import { isAccountId, requireAccountId } from "./account";
import { parseTokenAmount } from "./units";

test("NEARFlow uses named and implicit NEAR accounts", () => {
  for (const id of ["nearflow.testnet", "alice.testnet", "a".repeat(64)]) assert.equal(isAccountId(id), true);
  for (const id of ["", "A.testnet", "a..testnet", "-alice.testnet", "a".repeat(65), "alice\n"]) assert.equal(isAccountId(id), false);
  assert.throws(() => requireAccountId(""));
});
test("six-decimal token parsing is exact even above Number precision", () => {
  assert.equal(parseTokenAmount("1.000001"), 1_000_001n);
  assert.equal(parseTokenAmount("9007199254740993.123456"), 9007199254740993123456n);
  assert.equal(parseTokenAmount("0.000001"), 1n);
});
test("token parsing rejects rounding, exponent notation, negatives and overflow", () => {
  for (const amount of ["0", "-1", "1e6", "1.0000001", "NaN", "Infinity", "1.", "9".repeat(40)]) assert.throws(() => parseTokenAmount(amount));
});
