import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
const contracts = fileURLToPath(new URL("../../contracts/", import.meta.url));
const target = join(contracts, "exchange/target");
const output = join(contracts, "artifacts");
mkdirSync(output, { recursive: true });
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const hashes = {};
for (const [crate, name] of [["exchange", "nearflow_perps"], ["test-token", "nearflow_test_token"]]) {
  run("cargo", ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", target], join(contracts, crate));
  // Canonicalize newer LLVM encodings and lower instructions for NEAR's Wasm VM.
  run(process.execPath, [fileURLToPath(new URL("../node_modules/binaryen/bin/wasm-opt", import.meta.url)),
    join(target, `wasm32-unknown-unknown/release/${name}.wasm`), "-o", join(output, `${name}.wasm`), "-Oz",
    "--llvm-memory-copy-fill-lowering", "--signext-lowering", "--llvm-nontrapping-fptoint-lowering",
    "--strip-debug", "--strip-producers", "--strip-target-features"], contracts);
  hashes[`${name}.wasm`] = createHash("sha256").update(readFileSync(join(output, `${name}.wasm`))).digest("hex");
}
writeFileSync(join(output, "sha256.json"), JSON.stringify(hashes, null, 2) + "\n");
console.log("NEAR-compatible Wasm artifacts:", output);
