import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceEnvironment, serviceCommands } from "./build-local-service.mjs";
test("explicit local selector discards ambient online authority and fixes bundled service flags", () => {
  const env = serviceEnvironment({ PATH: "held-path", VITE_FORECAST_RUNTIME: "production", VITE_FORECAST_PUBLIC_KEY_ID: "ambient", CLOUDFLARE_API_TOKEN: "never-forward" });
  assert.equal(env.PATH, "held-path");
  assert.equal(env.VITE_SERVICE_CERTIFIED_SOLVER, "true");
  assert.equal(env.VITE_FORECAST_RUNTIME, "bundled");
  assert.equal(env.VITE_FORECAST_PUBLIC_KEY_ID, "");
  assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
});
test("selector keeps pinned guards/native build/formal package and check, no lifecycle/rebuild", () => {
  const commands = serviceCommands("held-output");
  assert.equal(commands.length, 5);
  assert.equal(commands[3][commands[3].indexOf("--configLoader") + 1], "native");
  assert.match(commands[4][2], /buildSiteProduction\(process.argv\[1\],true\)/);
  assert.doesNotMatch(JSON.stringify(commands), /npm |--rebuild/);
});
