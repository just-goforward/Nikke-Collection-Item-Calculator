import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("rebuild publishes Cargo output for default, absolute and crate-relative target directories", () => {
  const temporary = mkdtempSync(join(tmpdir(), "certified-builder-"));
  try {
    for (const mode of ["default", "absolute", "relative"]) {
      const root = join(temporary, mode);
      for (const directory of ["scripts", "rust/certified", "public", "shared/generated"])
        mkdirSync(join(root, directory), { recursive: true });
      for (const file of ["build-certified-wasm.ts", "certified-wasm-build-inputs.ts"])
        copyFileSync(new URL(file, import.meta.url), join(root, "scripts", file));
      writeFileSync(join(root, "package.json"), '{"type":"module"}');
      writeFileSync(join(root, "rust/certified/Cargo.toml"), "[package]\nname='fixture'\n");
      const preload = join(root, "cargo-boundary.mjs");
      writeFileSync(preload, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
childProcess.spawnSync = (command, args, options) => {
  const output = resolve(options.cwd, process.env.CARGO_TARGET_DIR || "target",
    "wasm32-unknown-unknown", "release");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "certified_wasm.wasm"), "fixture cargo output");
  return { status: 0 };
};
syncBuiltinESMExports();
`);
      const env = { ...process.env };
      delete env.CARGO_TARGET_DIR;
      if (mode === "absolute") env.CARGO_TARGET_DIR = join(temporary, "absolute-output");
      if (mode === "relative") env.CARGO_TARGET_DIR = "../relative-output";
      const result = spawnSync(process.execPath, [
        "--import", pathToFileURL(preload).href,
        join(root, "scripts/build-certified-wasm.ts"), "--rebuild",
      ], { cwd: root, env, encoding: "utf8" });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
      const bytes = readFileSync(join(root, "public/certified_solver.wasm"));
      assert.equal(bytes.toString(), "fixture cargo output");
      const hash = createHash("sha256").update(bytes).digest("hex");
      assert.ok(readFileSync(join(root, "shared/generated/certifiedWasmBuild.ts"), "utf8").includes(hash));
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
