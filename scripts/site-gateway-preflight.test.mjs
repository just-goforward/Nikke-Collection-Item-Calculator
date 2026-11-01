import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import { handleOptions } from "../cloudflare/src/http.ts";

mock.method(globalThis, "fetch", async () => assert.fail("External fetch is forbidden"));
after(async () => {
  mock.restoreAll();
  await stop();
});

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../site-worker/src/worker.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  logLevel: "silent",
});
const { default: gateway } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const config = readFileSync(new URL("../cloudflare/wrangler.toml", import.meta.url), "utf8");
const productionOrigins = JSON.parse(config.match(/^\[vars\]\s*\r?\nALLOWED_ORIGINS = ("[^"]*")/m)[1]);
const stagingOrigins = JSON.parse(config.match(/^\[env\.staging\.vars\]\s*\r?\nALLOWED_ORIGINS = ("[^"]*")/m)[1]);
const production = "https://nikkecollection.com";
const staging = "https://staging.nikkecollection.com";
const target = `${staging}/api/events`;
const ASSETS = { fetch: async () => assert.fail("API requests must not reach assets") };
const credentials = {
  Cookie: "private-cookie=fixture",
  Authorization: "Bearer private-fixture",
  "Proxy-Authorization": "Basic private-fixture",
};

function preflight(url = target, headers = {}) {
  return new Request(url, {
    method: "OPTIONS",
    headers: {
      Origin: production,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
      ...headers,
    },
  });
}

function assertForwarded(request, original) {
  assert.equal(request.url, original.url);
  assert.equal(request.method, original.method);
  assert.equal(request.redirect, "manual");
  assert.equal(request.headers.get("Origin"), original.headers.get("Origin"));
  for (const header of Object.keys(credentials)) assert.equal(request.headers.has(header), false);
}

test("events preflight uses backend CORS without expanding gateway write authority", async (t) => {
  await t.test("production selector preflights staging with unchanged Origin and no credentials", async () => {
    const original = preflight(target, credentials);
    let calls = 0;
    const response = await gateway.fetch(original, {
      ASSETS,
      STATS: {
        async fetch(request) {
          calls++;
          assertForwarded(request, original);
          assert.equal(request.headers.get("Access-Control-Request-Method"), "POST");
          assert.equal(request.headers.get("Access-Control-Request-Headers"), "content-type");
          // Use the pure backend CORS handler, not its D1/provider-backed event handler.
          return handleOptions(request, {
            ALLOWED_ORIGINS: stagingOrigins,
            get DB() { assert.fail("Preflight must not access D1"); },
          });
        },
      },
    });
    assert.equal(response.status, 204);
    assert.equal(calls, 1);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), production);
    assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
    assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Content-Type");
    assert.equal(response.headers.has("Access-Control-Allow-Credentials"), false);
    assert.equal(response.headers.get("Vary"), "Origin");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(await response.text(), "");
  });

  await t.test("backend environment allowlists alone decide origin authority", async () => {
    for (const [allowed, origin, expectedStatus, expectedOrigin] of [
      [stagingOrigins, staging, 204, staging],
      [productionOrigins, production, 204, production],
      [productionOrigins, staging, 403, null],
      [stagingOrigins, "https://untrusted.example", 403, null],
      [stagingOrigins, "null", 403, null],
    ]) {
      const original = preflight(target, { Origin: origin });
      let calls = 0;
      const response = await gateway.fetch(original, {
        ASSETS,
        STATS: { async fetch(request) {
          calls++;
          assertForwarded(request, original);
          return handleOptions(request, { ALLOWED_ORIGINS: allowed });
        } },
      });
      assert.equal(response.status, expectedStatus, origin);
      assert.equal(calls, 1);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), expectedOrigin);
      assert.equal(response.headers.has("Access-Control-Allow-Credentials"), false);
    }
  });

  await t.test("requested headers cannot create backend CORS authority", async () => {
    const original = preflight(target, {
      "Access-Control-Request-Headers": "content-type, authorization",
    });
    const response = await gateway.fetch(original, {
      ASSETS,
      STATS: { async fetch(request) {
        assertForwarded(request, original);
        assert.equal(request.headers.get("Access-Control-Request-Headers"), "content-type, authorization");
        return handleOptions(request, { ALLOWED_ORIGINS: stagingOrigins });
      } },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Content-Type");
    assert.equal(response.headers.has("Access-Control-Allow-Credentials"), false);
  });

  await t.test("missing preflight headers and unsupported requested methods never reach STATS", async () => {
    const requests = [
      new Request(target, { method: "OPTIONS" }),
      new Request(target, { method: "OPTIONS", headers: { Origin: production } }),
      new Request(target, { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST" } }),
      preflight(target, { Origin: "" }),
      ...["", "GET", "PUT", "DELETE", "OPTIONS", "post", "POST, DELETE"].map(method =>
        preflight(target, { "Access-Control-Request-Method": method })),
    ];
    for (const request of requests) {
      const response = await gateway.fetch(request, {
        ASSETS,
        STATS: { fetch: async () => assert.fail("Invalid preflight reached STATS") },
      });
      assert.equal(response.status, 405);
      assert.deepEqual(await response.json(), { error: "method_not_allowed" });
      assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
    }
  });

  await t.test("no other API or reserved route gains an OPTIONS path", async () => {
    for (const [path, status] of [
      ["/api/stats", 405],
      ["/api/_ci/stats-health", 404], ["/api/unknown", 404],
      ["/api/events/extra", 404], ["/auth", 404], ["/auth/callback", 404],
      ["/account", 404], ["/account/workspace", 404],
      ["/admin", 404], ["/v1", 404], ["/v1/events", 404],
    ]) {
      const response = await gateway.fetch(preflight(staging + path), {
        ASSETS,
        STATS: { fetch: async () => assert.fail("Reserved preflight reached STATS") },
      });
      assert.equal(response.status, status, path);
      assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
    }
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"]) {
      const response = await gateway.fetch(new Request(target, { method }), {
        ASSETS,
        STATS: { fetch: async () => assert.fail("Unsupported event method reached STATS") },
      });
      assert.equal(response.status, 405, method);
    }
  });

  await t.test("existing JSON POST still forwards its body and strips credentials and response cookies", async () => {
    const body = JSON.stringify({ version: 1, eventId: "synthetic-event-0001" });
    const original = new Request(target, {
      method: "POST",
      headers: { Origin: production, "Content-Type": "application/json", ...credentials },
      body,
    });
    let calls = 0;
    const response = await gateway.fetch(original, {
      ASSETS,
      STATS: { async fetch(request) {
        calls++;
        assertForwarded(request, original);
        assert.equal(request.headers.get("Content-Type"), "application/json");
        assert.equal(await request.text(), body);
        return Response.json({ ok: true }, { headers: { "Set-Cookie": "must-not-leak=1" } });
      } },
    });
    assert.equal(calls, 1);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.has("Set-Cookie"), false);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  });

  await t.test("preflight retains manual redirects and missing or failed service responses", async () => {
    const original = preflight();
    const redirect = await gateway.fetch(original, {
      ASSETS,
      STATS: { async fetch(request) {
        assertForwarded(request, original);
        return new Response(null, {
          status: 302,
          headers: { Location: "https://untrusted.example/no-follow", "Set-Cookie": "must-not-leak=1" },
        });
      } },
    });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("Location"), "https://untrusted.example/no-follow");
    assert.equal(redirect.headers.has("Set-Cookie"), false);
    const missing = await gateway.fetch(preflight(), { ASSETS });
    assert.equal(missing.status, 503);
    assert.deepEqual(await missing.json(), { error: "service_not_configured" });
    const warnings = [];
    const warn = t.mock.method(console, "warn", line => warnings.push(line));
    try {
      const failed = await gateway.fetch(preflight(), {
        ASSETS,
        STATS: { fetch: async () => { throw new Error("private-upstream-detail"); } },
      });
      assert.equal(failed.status, 502);
      assert.deepEqual(await failed.json(), { error: "service_unavailable" });
      assert.equal(failed.headers.get("Cache-Control"), "no-store");
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].includes("private-upstream-detail"), false);
    } finally {
      warn.mock.restore();
    }
  });
});

test("v3 decision preflight preserves legacy CORS but retires without fallback in the named profile", async () => {
  const original = preflight(`${staging}/api/decision-events`, credentials);
  let legacyCalls = 0;
  const legacy = await gateway.fetch(original, {
    ASSETS,
    STATS: {
      async fetch(request) {
        legacyCalls++;
        assertForwarded(request, original);
        assert.equal(request.headers.get("Access-Control-Request-Method"), "POST");
        assert.equal(request.headers.get("Access-Control-Request-Headers"), "content-type");
        return handleOptions(request, {
          ALLOWED_ORIGINS: stagingOrigins,
          get DB() { assert.fail("Legacy CORS must not access D1"); },
        });
      },
    },
  });
  assert.equal(legacyCalls, 1);
  assert.equal(legacy.status, 204);
  assert.equal(legacy.headers.get("Access-Control-Allow-Origin"), production);
  assert.equal(legacy.headers.get("Access-Control-Allow-Headers"), "Content-Type");
  assert.equal(legacy.headers.has("Access-Control-Allow-Credentials"), false);
  assert.equal(await legacy.text(), "");

  let namedCalls = 0, fallbackCalls = 0;
  const named = await gateway.fetch(preflight(`${staging}/api/decision-events`, credentials), {
    ASSETS,
    STATS_INGEST: {
      async fetch() { namedCalls++; assert.fail("Retired v3 must not invoke Ingest"); },
    },
    STATS: {
      async fetch() { fallbackCalls++; assert.fail("Retired v3 must not use legacy fallback"); },
    },
  });
  assert.equal(named.status, 410);
  assert.deepEqual(await named.json(), { error: "decision_v3_retired" });
  assert.equal(namedCalls, 0);
  assert.equal(fallbackCalls, 0);
});
