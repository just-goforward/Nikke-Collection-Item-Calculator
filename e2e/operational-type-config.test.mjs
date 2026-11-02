import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = fileURLToPath(new URL("../", import.meta.url));
const cli = join(source, "node_modules/typescript/bin/tsc");
const omitted = [
  "src/certifiedRuntime/controlledStableFixture.ts",
  "src/certifiedRuntime/controlledStableWorker.ts",
];
test("R10", { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "operational-r10-"));
  let invocation = 0;
  function compiler(args) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: source, env: process.env, windowsHide: true, encoding: "utf8",
      timeout: 25_000, maxBuffer: 4 * 1024 * 1024,
    });
    const id = String(++invocation).padStart(2, "0");
    writeFileSync(join(root, `${id}.stdout`), result.stdout ?? "");
    writeFileSync(join(root, `${id}.stderr`), result.stderr ?? "");
    strictEqual(result.error, undefined);
    strictEqual(result.signal, null);
    return result;
  }
  function configuration(path) {
    const result = compiler(["--showConfig", "-p", path]);
    strictEqual(result.status, 0);
    return JSON.parse(result.stdout);
  }
  const old = configuration("tsconfig.operations.json");
  const current = configuration("tsconfig.operational-ci.json");
  deepStrictEqual(current.compilerOptions, old.compilerOptions);
  deepStrictEqual(current.include, old.include);
  deepStrictEqual(current.exclude, [...old.exclude, ...omitted]);
  const normalize = paths => paths.map(path => relative(source, resolve(source, path)).replaceAll("\\", "/")).sort();
  deepStrictEqual(normalize(current.files), normalize(old.files).filter(path => !omitted.includes(path)));
  function closure(path) {
    const result = compiler(["--listFilesOnly", "-p", path]);
    strictEqual(result.status, 0);
    return normalize(result.stdout.trim().split(/\r?\n/));
  }
  const oldClosure = closure("tsconfig.operations.json");
  const currentClosure = closure("tsconfig.operational-ci.json");
  deepStrictEqual(currentClosure, oldClosure.filter(path => !omitted.includes(path)));

  // An exclude filters root discovery, not imports: future imports must stay visible.
  for (const present of [true, false]) {
    const project = join(root, present ? "present" : "missing");
    mkdirSync(project);
    const imported = join(project, "controlledStableFixture.ts");
    const entry = join(project, "entry.ts");
    writeFileSync(entry, 'export { value } from "./controlledStableFixture";\n');
    if (present) writeFileSync(imported, "export const value = 1;\n");
    const config = join(project, "tsconfig.json");
    writeFileSync(config, JSON.stringify({
      extends: join(source, "tsconfig.operational-ci.json"),
      // This isolated import-resolution fixture has no ambient package dependencies.
      compilerOptions: { types: [] },
      include: [entry], exclude: [imported],
    }));
    const checked = compiler(["--noEmit", "-p", config]);
    if (present) {
      strictEqual(checked.status, 0);
      const files = compiler(["--listFilesOnly", "-p", config]);
      strictEqual(files.status, 0);
      ok(files.stdout.replaceAll("\\", "/").includes(imported.replaceAll("\\", "/")));
    } else {
      ok(checked.status !== 0);
      ok(checked.stdout.includes("TS2307"));
    }
  }
  writeFileSync(join(root, "closure.json"), JSON.stringify({
    oldRoots: old.files.length, currentRoots: current.files.length,
    oldClosure: oldClosure.length, currentClosure: currentClosure.length,
    removed: oldClosure.filter(path => !currentClosure.includes(path)),
    importedExcludedStillResolved: true, missingImportFails: true,
  }));
});
