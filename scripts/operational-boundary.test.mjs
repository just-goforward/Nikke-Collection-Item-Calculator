import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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
  const p = json("package.json");
  assert.equal(p.workspaces.length, 7);
  for (const workspace of p.workspaces) assert(existsSync(workspace + "/package.json"));
  const config = json("tsconfig.operations.json");
  assert.equal(config.extends, "./tsconfig.json");
  for (const path of config.include.filter(v => !v.includes("*"))) assert(existsSync(path), path);
  assert(config.exclude.includes("benchmarks/**"));
  assert(json("tsconfig.json").include.includes("benchmarks/**/*.ts"));
});
