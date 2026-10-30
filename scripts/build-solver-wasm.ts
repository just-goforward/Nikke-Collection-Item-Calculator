import { spawnSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWasmRuntimeAssets } from "./wasm-runtime-assets.ts";

// Ordinary release builds validate pinned bytes. Recompilation is an explicit
// operator action; it cannot silently replace the retained deployed aliases.
if (!process.argv.includes("--rebuild")) {
  console.log(JSON.stringify(assertWasmRuntimeAssets()));
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = resolve(root, "rust", "solver-rs");
const output = resolve(crateDir, "target", "wasm32-unknown-unknown", "release", "solver_rs.wasm");
const publicOutput = resolve(root, "public", "solver_rs.wasm");

const result = spawnSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"], {
  cwd: crateDir,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

await mkdir(dirname(publicOutput), { recursive: true });
await copyFile(output, publicOutput);
console.log(`Copied ${output} -> ${publicOutput}`);
