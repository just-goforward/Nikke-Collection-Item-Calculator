import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProductionService, productionServiceEnvironment } from "./build-production-service.mjs";
import { serviceCommands } from "./build-local-service.mjs";

const sha = "a".repeat(40);
test("production fixes approved online trust while retaining the exact revision and CI guards", () => {
  const env = productionServiceEnvironment({
    GITHUB_SHA: sha, PATH: "held-path", VITE_SERVICE_CERTIFIED_SOLVER: "false",
    VITE_FORECAST_RUNTIME: "staging", VITE_FORECAST_PUBLIC_KEY_ID: "ambient",
    VITE_FORECAST_PUBLIC_KEY_BASE64: "ambient", CLOUDFLARE_API_TOKEN: "secret",
    UNRELATED_SECRET: "secret",
  });
  assert.equal(env.GITHUB_SHA, sha);
  assert.equal(env.CI, "true");
  assert.equal(env.WRANGLER_SEND_METRICS, "false");
  assert.equal(env.PATH, "held-path");
  assert.equal(env.VITE_SERVICE_CERTIFIED_SOLVER, "true");
  assert.equal(env.VITE_FORECAST_RUNTIME, "production");
  assert.equal(env.VITE_FORECAST_PUBLIC_KEY_ID, "production-v1");
  assert.equal(env.VITE_FORECAST_PUBLIC_KEY_BASE64, "BJAu/55jE5vGF7axWWKIp3RbjZyjm1QPY4IuqSzMf9Y=");
  assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(env.UNRELATED_SECRET, undefined);
});
test("production refuses a missing or non-full revision before executing", () => {
  for (const GITHUB_SHA of [undefined, "main", "A".repeat(40)]) {
    assert.throws(() => buildProductionService({ GITHUB_SHA }, () => assert.fail("must not execute")), /candidate commit/);
  }
});
test("production reuses the accepted guarded build and formal packaging chain at the published dist target", () => {
  const calls = [];
  buildProductionService({ GITHUB_SHA: sha }, (node, args, options) => {
    calls.push(args);
    assert.equal(node, process.execPath);
    assert.equal(options.env.GITHUB_SHA, sha);
    return { status: 0 };
  });
  assert.deepEqual(calls.slice(0, -1), serviceCommands("dist").slice(0, -1));
  assert.deepEqual(calls.at(-1), [
    "--input-type=module", "-e",
    "const {buildSiteProduction}=await import('./scripts/build-site-production.ts'); const {default:contract}=await import('./site-worker/production-forecast.proposed.json',{with:{type:'json'}}); await buildSiteProduction(process.argv[1],false,contract); await buildSiteProduction(process.argv[1],true,contract);",
    "dist",
  ]);
});
test("a failed build cannot proceed to packaging", () => {
  let calls = 0;
  assert.throws(() => buildProductionService({ GITHUB_SHA: sha }, () => {
    calls++;
    return { status: 1, signal: null };
  }), /Production service build failed/);
  assert.equal(calls, 1);
});
