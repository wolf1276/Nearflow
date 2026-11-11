export function parsePrice(value: string): bigint {
  if (value.trim() !== value || !/^\d+(?:\.\d{1,18})?$/.test(value)) throw new Error("Invalid decimal price");
  const [whole, fraction = ""] = value.split(".");
  const raw = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  if (raw <= 0n || raw > 10n ** 27n) throw new Error("Price outside contract bounds");
  return raw;
}
/** Exact six-decimal USDC input; reject hidden rounding or scientific notation. */
export function parseTokenAmount(value: string): bigint {
  if (value.trim() !== value || !/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error("Use a decimal amount with at most 6 decimal places");
  const [whole, fraction = ""] = value.split(".");
  const raw = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (raw <= 0n || raw >= 1n << 128n) throw new Error("Amount is outside the positive U128 range");
  return raw;
}
