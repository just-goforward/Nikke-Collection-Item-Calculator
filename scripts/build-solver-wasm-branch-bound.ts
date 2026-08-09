import { spawnSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = resolve(root, "rust", "solver-rs");
const buildOutput = resolve(
  crateDir,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "solver_rs.wasm",
);
const candidateOutput = resolve(root, "output", "solver_rs-branch-bound-audit.wasm");

const result = spawnSync(
  "cargo",
  [
    "build",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--features",
    "research-branch-bound",
  ],
  { cwd: crateDir, stdio: "inherit" },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

await mkdir(dirname(candidateOutput), { recursive: true });
await copyFile(buildOutput, candidateOutput);
console.log(`Copied isolated branch-bound audit candidate to ${candidateOutput}`);
