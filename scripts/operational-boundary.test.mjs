import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { parsePnpmLock } from "./pnpm-lock.mjs";
const json = file => JSON.parse(readFileSync(file, "utf8"));
test("operational commands cannot implicitly enter generic pretest or regeneration", () => {
  const p = json("package.json");
  for (const name of ["typecheck:operations", "test:operations", "build:operations"]) {
    assert.equal(p.scripts["pre" + name], undefined);
    assert.equal(p.scripts["post" + name], undefined);
    assert.doesNotMatch(p.scripts[name], /npm |--rebuild|prepare-certified-staging-oracle-cache/);
  }
  assert.equal(p.scripts["build:operations"], "node scripts/build-local-service.mjs");
});
test("all workspaces, frozen compiler options and operational roots remain present", () => {
  // The workspace manifest uses literal paths, not globs or other YAML forms.
  const packages = /^packages:\r?\n((?:  - [a-z][a-z0-9-]*\r?\n)+)(?=\S|$)/.exec(
    readFileSync("pnpm-workspace.yaml", "utf8"),
  );
  assert(packages, "expected a literal packages list in pnpm-workspace.yaml");
  const workspaces = packages[1].trimEnd().split(/\r?\n/).map(line => line.slice(4));
  assert.deepEqual([...workspaces].sort(), [
    "cloudflare",
    "forecast-collector",
    "forecast-dispatcher",
    "forecast-interactions",
    "personal-data",
    "stats-observer",
    "usage-guard",
  ]);
  for (const workspace of workspaces) assert(existsSync(workspace + "/package.json"));
  const lock = parsePnpmLock(readFileSync("pnpm-lock.yaml"));
  assert.deepEqual(Object.keys(lock.importers).sort(), [".", ...workspaces].sort());
  const config = json("tsconfig.operations.json");
  assert.equal(config.extends, "./tsconfig.json");
  for (const path of config.include.filter(v => !v.includes("*"))) assert(existsSync(path), path);
  assert(config.exclude.includes("benchmarks/**"));
  assert(json("tsconfig.json").include.includes("benchmarks/**/*.ts"));
});
