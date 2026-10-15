import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderLocalizedPage, renderSitemap } from "./localized-pages.ts";
import {
  assetUrlsFromHtml,
  checkedFetch,
  localePages,
  retryPagesSmoke,
  smokePages,
} from "./smoke-pages-deployment.mjs";

const options = {
  origin: "https://nikkecollection.com",
  revision: "a".repeat(40),
  hostingTarget: "pages",
};

test("Pages smoke never requests Worker-directed or unapproved hosts", async () => {
  const fetchImpl = () => assert.fail("must not fetch");
  await assert.rejects(
    checkedFetch(options.origin, "text/html", {
      ...options,
      fetchImpl,
      hostingTarget: "worker",
    }),
    /Worker hosting/,
  );
  await assert.rejects(
    checkedFetch("https://other.example", "text/html", {
      ...options,
      fetchImpl,
    }),
    /unapproved host/,
  );
  await assert.rejects(
    checkedFetch("https://site.workers.dev", "text/html", {
      ...options,
      origin: "https://site.workers.dev",
      fetchImpl,
    }),
    /Worker host/,
  );
});

test("Pages smoke refuses redirects without following them", async () => {
  await assert.rejects(
    checkedFetch(options.origin, "text/html", {
      ...options,
      fetchImpl: async (_url, init) => {
        assert.equal(init.redirect, "manual");
        return new Response(null, { status: 302, headers: { Location: "https://worker.example" } });
      },
    }),
    /unexpected redirect/,
  );
});

test("Pages smoke accepts the explicitly approved host", async () => {
  const response = await checkedFetch(options.origin, "text/html", {
    ...options,
    fetchImpl: async () => new Response("page", { headers: { "Content-Type": "text/html" } }),
  });
  assert.equal(await response.text(), "page");
});

test("legacy Pages URL follows redirects to the apex but rejects an unexpected final host", async () => {
  for (const destination of ["https://nikkecollection.com/en/", "https://other.example/en/"]) {
    const pending = checkedFetch("https://owner.github.io/en/", "text/html", {
      ...options,
      origin: "https://owner.github.io",
      fetchImpl: async (_url, init) => {
        assert.equal(init.redirect, "follow");
        const response = new Response("html", { headers: { "Content-Type": "text/html" } });
        Object.defineProperty(response, "url", { value: destination });
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
    });
    if (destination.startsWith(options.origin)) await pending;
    else await assert.rejects(pending, /unapproved response host/);
  }
});

test("real localized Pages HTML skips noscript fonts and data URLs without fetching them", async () => {
  const source = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(
    '<script type="module" src="/src/main.tsx"></script>',
    '<script src="/assets/index-abcdefgh.js"></script><link rel="stylesheet" href="/assets/index-abcdefgh.css" /><link rel="stylesheet" href="data:text/css,body{}" />',
  );
  const fetched = [];
  const result = await smokePages(options.origin, options.revision, async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, options.origin);
    fetched.push(url.pathname);
    const locale = localePages.find((entry) => `/${entry.path}` === url.pathname);
    if (locale) {
      const html = renderLocalizedPage(source, locale.lang);
      assert.ok(html.includes("<noscript>") && html.includes("https://cdn.jsdelivr.net"));
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }
    let body = "";
    let type = "";
    if (url.pathname.endsWith(".js")) {
      body = `"${options.revision}"`;
      type = "text/javascript";
    } else if (url.pathname.endsWith(".css")) {
      body = "body{}";
      type = "text/css";
    } else if (url.pathname.endsWith(".wasm")) {
      body = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 1, 0]);
      type = "application/wasm";
    } else if (url.pathname.endsWith(".png")) {
      body = new Uint8Array(5001);
      type = "image/png";
    } else if (url.pathname === "/robots.txt") {
      body = `Sitemap: ${options.origin}/sitemap.xml`;
      type = "text/plain";
    } else if (url.pathname === "/sitemap.xml") {
      body = renderSitemap();
      type = "application/xml";
    } else assert.fail(`Unexpected request ${url}`);
    return new Response(body, { headers: { "Content-Type": type } });
  });
  assert.equal(result.locales, 3);
  assert.equal(result.assets, 2);
  assert.equal(fetched.length, 11);
});

test("off-origin application assets are retained for rejection, never silently skipped", () => {
  for (const extension of ["js", "css", "wasm"]) {
    const tag =
      extension === "css"
        ? `<link rel="stylesheet" href="https://other.example/app.${extension}">`
        : `<script src="https://other.example/app.${extension}"></script>`;
    assert.equal(assetUrlsFromHtml(tag, options.origin)[0].origin, "https://other.example");
  }
});

test("CLI retry succeeds after transient failures and stops after ten failed attempts", async () => {
  for (const failCount of [2, 10]) {
    let calls = 0;
    const delays = [];
    const pending = retryPagesSmoke(options.origin, options.revision, {
      smoke: async (url, revision) => {
        assert.equal(url, options.origin);
        assert.equal(revision, options.revision);
        if (++calls <= failCount) throw new Error("not ready");
        return "ready";
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    if (failCount === 10) await assert.rejects(pending, /not ready/);
    else assert.equal(await pending, "ready");
    assert.equal(calls, Math.min(failCount + 1, 10));
    assert.deepEqual(delays, Array(Math.min(failCount, 9)).fill(6000));
  }
});
