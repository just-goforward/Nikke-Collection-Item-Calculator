import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { formalServiceCommands, serviceEnvironment, serviceCommands } from "./build-local-service.mjs";
import formal from "./formal-local-service.config.mjs";
import preview from "../vite.config.ts";
test("explicit local selector discards ambient online authority and fixes bundled service flags", () => {
  const env = serviceEnvironment({ PATH: "held-path", VITE_FORECAST_RUNTIME: "production", VITE_FORECAST_PUBLIC_KEY_ID: "ambient", CLOUDFLARE_API_TOKEN: "never-forward" });
  assert.equal(env.PATH, "held-path");
  assert.equal(env.VITE_SERVICE_CERTIFIED_SOLVER, "true");
  assert.equal(env.VITE_FORECAST_RUNTIME, "bundled");
  assert.equal(env.VITE_FORECAST_PUBLIC_KEY_ID, "");
  assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
});
test("selector keeps pinned guards/native build/formal package and check, no lifecycle/rebuild", () => {
  const commands = formalServiceCommands("held-output");
  const release = serviceCommands("held-output");
  assert.equal(commands[3][5], "scripts/formal-local-service.config.mjs");
  assert.equal(release[3][5], "scripts/local-service.config.mjs");
  assert.deepEqual(commands.slice(0, 3), release.slice(0, 3));
  assert.deepEqual(commands.slice(4), release.slice(4));
  assert.equal(commands.length, 5);
  assert.equal(commands[3][commands[3].indexOf("--configLoader") + 1], "native");
  assert.match(commands[4][2], /buildSiteProduction\(process.argv\[1\],true\)/);
  assert.doesNotMatch(JSON.stringify(commands), /npm |--rebuild/);
});

test("formal bundled entry retains shared guards but cannot acquire preview or root authority", () => {
  const root = resolve(import.meta.dirname, "..");
  const config = { command: "build", root, base: formal.base, build: formal.build, define: formal.define, env: serviceEnvironment({}) };
  const guard = formal.plugins.find(p => p?.name === "formal-local-bundled-only");
  guard.configResolved(config);
  assert.equal(formal.envDir, false);
  assert.throws(() => guard.configResolved({ ...config, base: "/preview/" }));
  assert.throws(() => guard.configResolved({ ...config, build: { outDir: "dist" } }));
  assert.throws(() => guard.configResolved({ ...config, define: { ...config.define, __PRODUCTION_ROOT_SITE__: "true" } }));
  for (const change of [{ VITE_FORECAST_RUNTIME: "production" }, { VITE_PREVIEW_LEGACY_D0: "true" },
    { VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64: "unexpected" }, { VITE_ROOT_CONDITIONAL_PUBLIC_KEY: "unexpected" }]) {
    assert.throws(() => guard.configResolved({ ...config, env: { ...config.env, ...change } }));
  }
  for (const plugin of preview.plugins) {
    if (plugin?.name === "preview-only-trust") {
      assert.equal(formal.plugins.includes(plugin), false);
      assert.throws(() => plugin.configResolved(config), /preview_only_configuration_required/);
    } else assert(formal.plugins.includes(plugin));
  }
  assert(formal.plugins.some(p => p?.name === "service-h14-emitted-lane-receipt"));
});
