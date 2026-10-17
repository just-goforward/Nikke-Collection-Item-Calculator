import { pathToFileURL } from "node:url";
import {
  assert,
  assetUrlsFromHtml,
  checkedFetch,
  localePages,
  verifyLocalizedHtml,
} from "./smoke-pages-deployment.mjs";

const ORIGIN = "https://nikkecollection.com";
const STATS = "https://nikkecollection.com";
const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|wasm)$/;

export function verifyCacheHeaders(response, path) {
  const cache = response.headers.get("cache-control") ?? "";
  if (/immutable/i.test(cache)) {
    assert(HASHED_ASSET.test(path), `${path}: only hashed assets may be immutable`);
  }
  if (["/", "/en/", "/ja/", "/solver_rs.wasm", "/certified_solver.wasm"].includes(path)) {
    assert(
      /\bno-cache\b/i.test(cache) ||
        (/\bmax-age\s*=\s*0\b/i.test(cache) && /\bmust-revalidate\b/i.test(cache)),
      `${path}: HTML/fixed WASM must revalidate`,
    );
    assert(!/\b(?:s-maxage|max-age)\s*=\s*[1-9]/i.test(cache), `${path}: cache is stale`);
  }
}

export function verifyProductionHtml(html, response, locale) {
  verifyLocalizedHtml(html, locale);
  assert(!/data-site-staging|statsEnv",\s*"staging"/i.test(html), "staging HTML is forbidden");
  assert(
    !/<meta\b[^>]*(?:noindex|http-equiv=["']Content-Security-Policy)/i.test(html),
    "public HTML has CSP/noindex",
  );
  assert(!response.headers.has("content-security-policy"), "public HTML has CSP");
  assert(
    !response.headers.has("content-security-policy-report-only"),
    "public HTML has report-only CSP",
  );
  assert(!/noindex/i.test(response.headers.get("x-robots-tag") ?? ""), "public HTML has noindex");
  // accountFeatureEnabled() is opt-in: absence and explicit false are both accounts-off.
  assert(
    !html.includes("COLLECTION_ACCOUNT_CONFIG") ||
      (/window\.COLLECTION_ACCOUNT_CONFIG\s*=\s*\{\s*enabled:\s*false\s*[,}]/.test(html) &&
        !/window\.COLLECTION_ACCOUNT_CONFIG\s*=\s*\{[^}]*enabled:\s*true/.test(html)),
    "accounts must remain disabled",
  );
  const stats = html.match(
    /window\.COLLECTION_STATS_CONFIG\s*=\s*\{\s*endpoint:\s*["']([^"']+)/,
  )?.[1];
  assert(stats === STATS, "production stats endpoint is missing");
}

/** Read-only public smoke: no cookies, OAuth, event writes, or private account operations. */
export async function smokeSiteProduction(origin, revision, { fetchImpl = fetch } = {}) {
  assert(origin === ORIGIN, "Explicit production origin must be https://nikkecollection.com");
  assert(/^[0-9a-f]{40}$/.test(revision), "Expected a full lowercase commit SHA");
  const lifetime = AbortSignal.timeout(120_000);
  let requests = 0;
  let totalBytes = 0;
  async function get(path, type, status = 200, method = "GET") {
    assert(++requests <= 80, "Smoke request budget exceeded");
    const url = new URL(path, origin);
    const options = {
      origin,
      revision,
      fetchImpl,
      siteWorker: true,
      status,
      method,
      signal: AbortSignal.any([lifetime, AbortSignal.timeout(15_000)]),
    };
    let response;
    if (path === "/api/stats" && method === "GET") {
      response = await fetchImpl(url, {
        cache: "no-store",
        redirect: "manual",
        credentials: "omit",
        method,
        signal: options.signal,
      });
      assert(!response.redirected, `${path}: unexpected redirect`);
      assert(!response.url || new URL(response.url).origin === origin, `${path}: unapproved host`);
      assert(response.status === 200, `${path}: expected 200`);
      if (response.status === 200)
        assert(
          response.headers.get("content-type")?.includes("application/json"),
          `${path}: unexpected Content-Type`,
        );
    } else {
      response = await checkedFetch(url, type, options);
    }
    assert(!response.headers.has("set-cookie"), `${path}: public smoke must remain cookie-free`);
    verifyCacheHeaders(response, url.pathname);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      totalBytes += chunk.byteLength;
      assert(
        size <= 20 * 1024 * 1024 && totalBytes <= 64 * 1024 * 1024,
        "Smoke byte budget exceeded",
      );
      chunks.push(chunk);
    }
    return { response, bytes: Buffer.concat(chunks), url };
  }
  const assets = new Map();
  const entryScripts = new Set();
  for (const locale of localePages) {
    const { response, bytes, url } = await get(`/${locale.path}`, "text/html");
    const html = bytes.toString("utf8");
    verifyProductionHtml(html, response, locale);
    const linked = assetUrlsFromHtml(html, url);
    assert(
      linked.some((asset) => asset.pathname.endsWith(".js")),
      "missing JS entry asset",
    );
    assert(
      linked.some((asset) => asset.pathname.endsWith(".css")),
      "missing CSS asset",
    );
    for (const asset of linked) {
      assets.set(asset.href, asset);
      if (asset.pathname.endsWith(".js")) entryScripts.add(asset.href);
    }
  }
  assets.set(`${origin}/solver_rs.wasm`, new URL("/solver_rs.wasm", origin));
  assets.set(`${origin}/certified_solver.wasm`, new URL("/certified_solver.wasm", origin));
  for (const asset of assets.values()) {
    const type = asset.pathname.endsWith(".js")
      ? "javascript"
      : asset.pathname.endsWith(".css")
        ? "text/css"
        : "application/wasm";
    const { bytes } = await get(asset.href, type);
    assert(bytes.length > 0, `${asset.pathname}: empty asset`);
    if (type === "application/wasm") {
      assert(WebAssembly.validate(bytes), `${asset.pathname}: invalid WASM`);
    } else {
      const text = bytes.toString("utf8");
      assert(!/^\s*</.test(text), `${asset.pathname}: HTML returned instead of asset`);
      if (type === "javascript") {
        if (entryScripts.has(asset.href)) {
          assert(
            new RegExp(`(?<![0-9a-fA-F])${revision}(?![0-9a-fA-F])`).test(text),
            `${asset.pathname}: frontend revision does not match ${revision}`,
          );
        }
        // Check same-origin emitted chunks/WASM, including lazily loaded hashed assets.
        for (const match of text.matchAll(/["'](\/assets\/[^"'\\]+\.(?:js|css|wasm))["']/g)) {
          const referenced = new URL(match[1], origin);
          assets.set(referenced.href, referenced);
        }
      }
    }
  }
  const robots = (await get("/robots.txt", "text/plain")).bytes.toString("utf8");
  assert(
    /^User-agent:\s*\*\s*$/m.test(robots) && /^Allow:\s*\/\s*$/m.test(robots),
    "robots must allow production",
  );
  assert(!/^Disallow:\s*\/.*$/m.test(robots), "robots disallows production");
  assert(robots.includes(`Sitemap: ${origin}/sitemap.xml`), "robots missing Sitemap");
  const sitemap = (await get("/sitemap.xml", "xml")).bytes.toString("utf8");
  const locations = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  assert(
    JSON.stringify(locations) === JSON.stringify(localePages.map((locale) => locale.canonical)),
    "sitemap locations mismatch",
  );
  // Public stats only. Never call OAuth callbacks, login/logout, personal-data, or /api/events.
  const stats = await get("/api/stats", "application/json");
  if (stats.response.status === 200) {
    const aggregate = JSON.parse(stats.bytes.toString("utf8"));
    assert(
      aggregate !== null &&
        typeof aggregate === "object" &&
        ["events", "attempts", "greatSuccesses"].every(
          (key) => Number.isFinite(aggregate.summary?.[key]) && aggregate.summary[key] >= 0,
        ) &&
        Array.isArray(aggregate.byKit),
      "/api/stats: aggregate response is missing",
    );
  }
  for (const path of ["/v1/statistics"]) {
    const { response } = await get(path, "application/json", 503);
    assert(response.headers.get("cache-control") === "no-store", `${path}: error must not cache`);
  }
  for (const path of [
    "/api",
    "/auth",
    "/v1",
    "/api/unknown",
    "/auth/unknown",
    "/v1/unknown",
    "/api/health",
  ]) {
    await get(path, "application/json", 404);
  }
  // HEAD is side-effect-free and intentionally not in these route method allowlists.
  await get("/api/stats", "", 405, "HEAD");
  await get("/auth/login/google", "", 405, "HEAD");
  return {
    origin,
    revision,
    locales: localePages.length,
    assets: assets.size,
    requests,
    totalBytes,
  };
}

/**
 * Edge propagation after `wrangler deploy` can briefly serve the previous frontend.
 * Only a revision mismatch is retried; every other failure is final.
 */
export async function smokeSiteProductionAfterDeploy(
  origin,
  revision,
  {
    attempts = 6,
    delayMs = 10_000,
    smoke = smokeSiteProduction,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await smoke(origin, revision);
    } catch (error) {
      const stale =
        error instanceof Error && /frontend revision does not match/.test(error.message);
      if (!stale || attempt >= attempts) throw error;
      await sleep(delayMs);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [origin, revision] = process.argv.slice(2);
  if (!origin || !revision) {
    throw new Error("Usage: npm run smoke:site-production-deployed -- <origin> <candidate-sha>");
  }
  console.log(JSON.stringify(await smokeSiteProductionAfterDeploy(origin, revision)));
}
