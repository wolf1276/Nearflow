export function isAccountId(value: string): boolean {
  return value.trim() === value && value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value);
}
export function requireAccountId(value: string): string {
  if (!isAccountId(value)) throw new Error(`Invalid or unconfigured NEAR account ID: ${value || "(empty)"}`);
  return value;
}
