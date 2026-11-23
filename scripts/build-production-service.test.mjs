import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProductionService, productionServiceEnvironment } from "./build-production-service.mjs";
import productionProposal from "../site-worker/production-forecast.proposed.json" with { type: "json" };
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../shared/certifiedEngineProfile.ts";

import { generateKeyPairSync } from "node:crypto";
import timedProposal from "../site-worker/production-forecast-timed-v1.proposed.json" with { type: "json" };
import { forecastRuntimeBuildPlugin } from "./forecast-runtime-build.ts";

const sha = "a".repeat(40);
// Process-local fixture only: never rewrite the operator's checked-in proposal.
function currentEngineContract(t) {
  const oldTimed = { ...timedProposal };
  const { publicKey } = generateKeyPairSync("ed25519");
  timedProposal.publicKeyBase64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  t.after(() => Object.assign(timedProposal, oldTimed));
  const previous = productionProposal.engineProfile;
  productionProposal.engineProfile = { ...CERTIFIED_STAGING_ENGINE_PROFILE };
  t.after(() => { productionProposal.engineProfile = previous; });
}
test("production fixes approved online trust while retaining the exact revision and CI guards", t => {
  currentEngineContract(t);
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
  assert.equal(env.VITE_FORECAST_TIMED_V1_PUBLIC_KEY_ID, "production-timed-v1");
  assert.equal(env.VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64, timedProposal.publicKeyBase64);
  const plugin = forecastRuntimeBuildPlugin();
  plugin.configResolved({ env });
  let metadata;
  plugin.generateBundle.call({ emitFile(file) { metadata = JSON.parse(file.source); } });
  assert.deepEqual(metadata.timedV1, timedProposal);
  for (const key of [undefined, productionProposal.publicKeyBase64]) {
    assert.throws(() => plugin.configResolved({env: {...env, VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64: key}}), /timed_v1_build_trust_mismatch/);
    timedProposal.publicKeyBase64 = key;
    assert.throws(() => productionServiceEnvironment({GITHUB_SHA: sha}), /timed_v1_public_trust_missing_or_invalid/);
    timedProposal.publicKeyBase64 = env.VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64;
  }
  timedProposal.keyId = productionProposal.keyId;
  assert.throws(() => productionServiceEnvironment({GITHUB_SHA: sha}), /timed_v1_public_trust_missing_or_invalid/);
  assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(env.UNRELATED_SECRET, undefined);
});
test("production refuses a missing or non-full revision before executing", () => {
  for (const GITHUB_SHA of [undefined, "main", "A".repeat(40)]) {
    assert.throws(() => buildProductionService({ GITHUB_SHA }, () => assert.fail("must not execute")), /candidate commit/);
  }
});
test("production rejects stale engine trust before executing any build", t => {
  currentEngineContract(t);
  productionProposal.engineProfile = { ...productionProposal.engineProfile, codeHash: "0".repeat(64) };
  let calls = 0;
  assert.throws(() => buildProductionService({ GITHUB_SHA: sha }, () => { calls++; }),
    /certified_engine_profile_mismatch/);
  assert.equal(calls, 0);
});
test("a failed build cannot proceed to packaging", t => {
  currentEngineContract(t);
  let calls = 0;
  assert.throws(() => buildProductionService({ GITHUB_SHA: sha }, () => {
    calls++;
    return { status: 1, signal: null };
  }), /Production service build failed/);
  assert.equal(calls, 1);
});
