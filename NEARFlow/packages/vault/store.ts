import { createHash } from "node:crypto";
import { open, readFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export function encode(value: unknown): string {
  return JSON.stringify(value, (_, v) => typeof v === "bigint" ? { $bigint: v.toString() } : v);
}
export function decode<T>(text: string): T {
  return JSON.parse(text, (_, v) => v && typeof v === "object" && Object.keys(v).length === 1 && typeof v.$bigint === "string"
    && /^-?(0|[1-9][0-9]*)$/.test(v.$bigint) ? BigInt(v.$bigint) : v) as T;
}
export const hash = (v: unknown) => createHash("sha256").update(encode(v)).digest("hex");

// Single-host, exclusive writer. A crash-held lock requires operator inspection,
// never automatic lock stealing or a blind order retry. Directory must be trusted.
export class Store<T> {
  constructor(readonly path: string) {}
  async load(): Promise<T | null> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    const envelope = JSON.parse(text) as { version: number; payload: string; digest: string };
    if (envelope.version !== 1 || typeof envelope.payload !== "string" || hash(envelope.payload) !== envelope.digest) throw Error("Corrupt journal");
    return decode<T>(envelope.payload);
  }
  async exclusive<R>(fn: () => Promise<R>): Promise<R> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = await open(`${this.path}.lock`, "wx", 0o600);
    try { return await fn(); }
    finally { await lock.close(); await unlink(`${this.path}.lock`); }
  }
  async transaction<R>(fn: (state: T | null) => Promise<{ state: T; result: R }>): Promise<R> {
    return this.exclusive(async () => {
      const { state, result } = await fn(await this.load());
      const payload = encode(state);
      const tmp = `${this.path}.tmp`;
      const file = await open(tmp, "w", 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, payload, digest: hash(payload) })); await file.sync(); }
      finally { await file.close(); }
      await rename(tmp, this.path);
      const directory = await open(dirname(this.path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return result;
    });
  }
}
