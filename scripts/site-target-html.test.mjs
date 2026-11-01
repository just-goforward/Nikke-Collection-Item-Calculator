import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { siteTargetHtml } from "./build-site-production.ts";

test("production removes staging configuration while staging keeps gateway selectors and UI", () => {
  const html = `<main>Unchanged calculator</main><script>
window.COLLECTION_STATS_CONFIG = {
  production: { endpoint: "https://nikkecollection.com", turnstileSiteKey: "production-key" },
  staging: { endpoint: "https://legacy-stats.workers.dev", turnstileSiteKey: "staging-key" }
};
</script>`;
  const configuration = (value) => {
    const context = { window: {} };
    runInNewContext(value.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    return JSON.parse(JSON.stringify(context.window.COLLECTION_STATS_CONFIG));
  };
  const production = siteTargetHtml(html, "production");
  assert.deepEqual(configuration(production), {
    production: { endpoint: "https://nikkecollection.com", turnstileSiteKey: "production-key" },
  });
  const staging = siteTargetHtml(html, "staging");
  assert.deepEqual(configuration(staging), {
    production: { endpoint: "https://staging.nikkecollection.com", turnstileSiteKey: "staging-key" },
    staging: { endpoint: "https://staging.nikkecollection.com", turnstileSiteKey: "staging-key" },
  });
  for (const packaged of [production, staging]) {
    assert.equal(packaged.slice(0, packaged.indexOf("<script>")), "<main>Unchanged calculator</main>");
    assert.equal(siteTargetHtml(packaged, packaged === production ? "production" : "staging"), packaged);
  }
});

test("legal HTML stays unchanged while declared application pages require statistics configuration", () => {
  const legal = "<html><main>Privacy policy</main></html>";
  for (const target of ["production", "staging"]) {
    for (const path of ["privacy.html", "en/privacy.html", "ja/terms.html"]) {
      assert.equal(siteTargetHtml(legal, target, path), legal);
    }
    for (const path of ["index.html", "en/index.html", "ja/index.html"]) {
      assert.throws(
        () => siteTargetHtml(legal, target, path),
        /Expected exactly one stats configuration script/,
      );
    }
  }
});
