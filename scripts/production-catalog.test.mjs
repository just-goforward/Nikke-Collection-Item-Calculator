import { test } from "node:test";
import assert from "node:assert/strict";
import { renderedProductionFiles, renderDecisionProductionCatalog } from "./render-production-operations.mjs";

test("release generation follows the approved worker configuration scope", () => {
  assert.deepEqual(
    [...renderedProductionFiles().keys()].filter(path => path.endsWith(".toml")),
    [
      "site-worker/rebuild.production.wrangler.toml",
      "cloudflare/rebuild.production.wrangler.toml",
      "forecast-collector/rebuild.production.wrangler.toml",
      "forecast-dispatcher/rebuild.production.wrangler.toml",
      "forecast-interactions/rebuild.production.wrangler.toml",
      "usage-guard/wrangler.toml",
    ],
  );
});

test("unresolved public operating inputs keep collection disabled", () => {
  const view = JSON.parse(renderDecisionProductionCatalog({
    enabled: false, producer: null, allowedProducers: [], turnstileSiteKey: null,
  }));
  assert.equal(view.enabled, false);
  assert.deepEqual(view.publications, []);
});

test("requesting enabled collection without actual producer and sitekey fails closed", () => {
  assert.throws(() => renderDecisionProductionCatalog({
    enabled: true, producer: null, allowedProducers: [], turnstileSiteKey: null,
  }), /inputs unresolved/);
});

test("synthetic approved input projects only public configuration, never unsigned mappings or secrets", () => {
  const producer = { producerVersion: "synthetic-fixture", producerCodeHash: "a".repeat(64) };
  const view = JSON.parse(renderDecisionProductionCatalog({
    enabled: true, producer, allowedProducers: [producer], turnstileSiteKey: "synthetic_sitekey",
    publications: [{ contentHash: "b".repeat(64) }], signingKey: "synthetic-private-material",
  }));
  assert.equal(view.enabled, true);
  assert.deepEqual(view.producer, producer);
  assert.deepEqual(view.allowedProducers, [producer]);
  assert.equal(view.turnstileSiteKey, "synthetic_sitekey");
  assert.deepEqual(view.publications, []);
  assert.equal(JSON.stringify(view).includes("synthetic-private-material"), false);
});
