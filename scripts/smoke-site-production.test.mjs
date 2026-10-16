import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderLocalizedPage } from "./localized-pages.ts";
import { localePages } from "./smoke-pages-deployment.mjs";
import { smokeSiteProduction, verifyCacheHeaders } from "./smoke-site-production.mjs";

const origin = "https://nikkecollection.com";
const revision = "a".repeat(40);

function html(locale) {
  const source = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(
    '<script type="module" src="/src/main.tsx"></script>',
    '<script src="/assets/index-abcdefgh.js"></script><link rel="stylesheet" href="/assets/index-abcdefgh.css" />',
  );
  const rendered = renderLocalizedPage(source, locale.lang);
  assert.ok(rendered.includes("<noscript>") && rendered.includes("https://cdn.jsdelivr.net"));
  return rendered;
}

function fixture(change = () => {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin, origin);
      assert.equal(init.redirect, "manual");
      assert.equal(init.credentials, "omit");
      assert.ok(init.signal instanceof AbortSignal);
      const path = url.pathname;
      calls.push([path, init.method]);
      const locale = localePages.find((entry) => `/${entry.path}` === path);
      const result = {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: '{"error":"service_not_configured"}',
      };
      if (locale) {
        result.headers = {
          "Content-Type": "text/html",
          "Cache-Control": "public, max-age=0, must-revalidate",
        };
        result.body = html(locale);
      } else if (path.endsWith(".js")) {
        result.headers = {
          "Content-Type": "text/javascript",
          "Cache-Control": "public, max-age=31536000, immutable",
        };
        // Real minified entry shape: document.documentElement.dataset.buildRevision=`local`,Se().
        result.body = `document.documentElement.dataset.buildRevision=\`${revision}\`,Se()`;
      } else if (path.endsWith(".css")) {
        result.headers = {
          "Content-Type": "text/css",
          "Cache-Control": "public, max-age=31536000, immutable",
        };
        result.body = "body{color:black}";
      } else if (path.endsWith(".wasm")) {
        result.headers["Content-Type"] = "application/wasm";
        result.headers["Cache-Control"] = "public, max-age=0, must-revalidate";
        result.body = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
      } else if (path === "/robots.txt") {
        result.headers["Content-Type"] = "text/plain";
        result.body = `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
      } else if (path === "/sitemap.xml") {
        result.headers["Content-Type"] = "application/xml";
        result.body = `<urlset>${localePages.map((entry) => `<url><loc>${entry.canonical}</loc></url>`).join("")}</urlset>`;
      } else if (init.method === "HEAD") {
        result.status = 405;
        result.body = null;
      } else {
        result.status = ["/api/stats", "/v1/statistics"].includes(path) ? 503 : 404;
      }
      change(path, result);
      return new Response(result.body, { status: result.status, headers: result.headers });
    },
  };
}

test("production smoke verifies locales, assets, revision, SEO, cache and read-only reserved routes", async () => {
  const source = fixture();
  const result = await smokeSiteProduction(origin, revision, source);
  assert.equal(result.locales, 3);
  assert.equal(result.assets, 4);
  assert.ok(result.requests <= 80);
  assert.ok(source.calls.every(([, method]) => ["GET", "HEAD"].includes(method)));
  assert.ok(
    !source.calls.some(([path]) => /events|callback|logout|workspace|export|consent/.test(path)),
  );
});

const beaconTag = (src = "https://static.cloudflareinsights.com/beacon.min.js") =>
  `<script defer src="${src}" integrity="sha512-x" data-cf-beacon='{"token":"t"}' crossorigin="anonymous"></script>`;

test("production smoke passes with and without the injected Web Analytics beacon, never fetching it", async () => {
  for (const inject of [
    null,
    "https://static.cloudflareinsights.com/beacon.min.js",
    "https://static.cloudflareinsights.com/beacon.min.js/vcd15cbe7772f49c399c6a5babf22c1241717689176015",
  ]) {
    const source = fixture((path, result) => {
      if (inject && localePages.some((entry) => `/${entry.path}` === path)) {
        result.body = result.body.replace("</body>", `${beaconTag(inject)}</body>`);
        assert.ok(result.body.includes("cloudflareinsights"));
      }
    });
    const result = await smokeSiteProduction(origin, revision, source);
    assert.equal(result.assets, 4);
    assert.ok(!source.calls.some(([path]) => path.includes("beacon")));
  }
});

test("rejects any other off-origin script next to the beacon", async () => {
  for (const src of [
    "https://static.cloudflareinsights.com/other.js",
    "https://static.cloudflareinsights.com/beacon.min.js?token=t",
    "https://static.cloudflareinsights.com/beacon.min.js/v1/x",
    "https://static.cloudflareinsights.com/beacon.min.js/v1?x=1",
    "https://static.cloudflareinsights.com/beacon.min.jsX",
    "https://other.example/beacon.min.js",
    "https://other.example/beacon.min.js/v1",
  ]) {
    const source = fixture((path, result) => {
      if (path === "/")
        result.body = result.body.replace(
          "</body>",
          `${beaconTag()}<script src="${src}"></script></body>`,
        );
    });
    await assert.rejects(smokeSiteProduction(origin, revision, source), /unapproved host/);
  }
});

test("rejects wrong SHA and wrong host without networking outside the supplied origin", async () => {
  await assert.rejects(smokeSiteProduction(origin, "b".repeat(40), fixture()), /revision/);
  await assert.rejects(
    smokeSiteProduction("https://staging.nikkecollection.com", revision, {
      fetchImpl: () => assert.fail("must not fetch"),
    }),
    /production origin/,
  );
});

test("rejects an expected revision embedded in a longer hexadecimal run", async () => {
  for (const value of [`f${revision}`, `${revision}0`]) {
    const source = fixture((path, result) => {
      if (path.endsWith(".js")) {
        result.body = `document.documentElement.dataset.buildRevision=\`${value}\`,Se()`;
      }
    });
    await assert.rejects(smokeSiteProduction(origin, revision, source), /revision does not match/);
  }
});

for (const [name, change, error] of [
  [
    "wrong asset host",
    (path, value) => {
      if (path === "/")
        value.body = value.body.replace('src="/assets/', 'src="https://other.example/assets/');
    },
    /unapproved host/,
  ],
  [
    "staging HTML",
    (path, value) => {
      if (path === "/") value.body += '<script data-site-staging="true"></script>';
    },
    /staging HTML/,
  ],
  [
    "unexpected redirect",
    (path, value) => {
      if (path === "/") {
        value.status = 302;
        value.headers.Location = "https://other.example";
      }
    },
    /unexpected redirect/,
  ],
  [
    "missing sitemap",
    (path, value) => {
      if (path === "/sitemap.xml") value.status = 404;
    },
    /expected 200/,
  ],
  [
    "bad HTML cache",
    (path, value) => {
      if (path === "/") value.headers["Cache-Control"] = "public, max-age=3600";
    },
    /must revalidate/,
  ],
  [
    "immutable fixed WASM",
    (path, value) => {
      if (path === "/solver_rs.wasm") value.headers["Cache-Control"] = "public, immutable";
    },
    /only hashed assets/,
  ],
  [
    "accounts enabled",
    (path, value) => {
      if (path === "/")
        value.body += "<script>window.COLLECTION_ACCOUNT_CONFIG = { enabled: true };</script>";
    },
    /accounts/,
  ],
  [
    "staging CSP",
    (path, value) => {
      if (path === "/") value.headers["Content-Security-Policy"] = "default-src 'self'";
    },
    /CSP/,
  ],
  [
    "invalid WASM",
    (path, value) => {
      if (path === "/solver_rs.wasm") value.body = "not wasm";
    },
    /invalid WASM/,
  ],
  [
    "noindex",
    (path, value) => {
      if (path === "/") value.headers["X-Robots-Tag"] = "noindex";
    },
    /noindex/,
  ],
]) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(smokeSiteProduction(origin, revision, fixture(change)), error);
  });
}

test("both fixed WASM files require positive revalidation, not merely absence of immutable", () => {
  for (const path of ["/solver_rs.wasm", "/certified_solver.wasm"]) {
    for (const cache of [null, "public, max-age=3600", "public, max-age=0"]) {
      const headers = cache ? { "Cache-Control": cache } : {};
      assert.throws(() => verifyCacheHeaders(new Response("", { headers }), path), /revalidate/);
    }
    for (const cache of ["no-cache", "public, max-age=0, must-revalidate"]) {
      assert.doesNotThrow(() =>
        verifyCacheHeaders(new Response("", { headers: { "Cache-Control": cache } }), path),
      );
    }
  }
});
