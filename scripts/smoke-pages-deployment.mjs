import { pathToFileURL } from "node:url";
import { SITE_LOCALES } from "../shared/siteLocales.ts";
import { pagesPublicationPolicy } from "./site-hosting-policy.ts";

export const localePages = [
  {
    canonical: "https://nikkecollection.com/",
    lang: "ko",
    path: "",
    title: "NIKKE 소장품 레벨업 계산기",
  },
  {
    canonical: "https://nikkecollection.com/en/",
    lang: "en",
    path: "en/",
    title: "NIKKE Collection Item Upgrade Calculator",
  },
  {
    canonical: "https://nikkecollection.com/ja/",
    lang: "ja",
    path: "ja/",
    title: "NIKKE コレクション強化計算機",
  },
];
const canonicalUrls = localePages.map(({ canonical }) => canonical);
/** Sitemap order: locale homes, then each locale's legal pages. */
export const sitemapUrls = [
  ...canonicalUrls,
  ...canonicalUrls.flatMap((canonical) =>
    ["privacy", "terms", "licenses"].map((page) => `${canonical}${page}`),
  ),
];
// Optional script Cloudflare Web Analytics may inject at the edge (documented or versioned form);
// it is not a site asset.
const WEB_ANALYTICS_BEACON =
  /^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js(?:\/v[A-Za-z0-9]{1,128})?$/;
const ogImagePaths = localePages.map(({ lang }) => `og/collection-calculator-${lang}.png`);

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** The apex is redirect-free; legacy Pages URLs may redirect to the approved HTTPS apex. */
export async function checkedFetch(url, expectedType, options) {
  const {
    origin,
    revision,
    fetchImpl = fetch,
    hostingTarget = process.env.SITE_HOSTING_TARGET,
    siteWorker = false,
    method = "GET",
    status = 200,
    signal = AbortSignal.timeout(15_000),
  } = options;
  if (!siteWorker) {
    assert(pagesPublicationPolicy(hostingTarget).smokePages, "Pages smoke refuses Worker hosting");
  }
  const requestUrl = new URL(url);
  assert(requestUrl.origin === origin, `${url}: unapproved host`);
  assert(
    requestUrl.protocol === "https:" && !requestUrl.username && !requestUrl.password,
    "HTTPS origin required",
  );
  if (!siteWorker)
    assert(!requestUrl.hostname.endsWith(".workers.dev"), "Pages smoke refuses Worker host");
  requestUrl.searchParams.set("deployment-smoke", revision);
  const strictRedirects = siteWorker || origin === "https://nikkecollection.com";
  const response = await fetchImpl(requestUrl, {
    cache: "no-store",
    redirect: strictRedirects ? "manual" : "follow",
    credentials: "omit",
    method,
    signal,
  });
  assert(
    !strictRedirects ||
      (!response.redirected && !(response.status >= 300 && response.status < 400)),
    `${url}: unexpected redirect`,
  );
  assert(
    !response.url ||
      new URL(response.url).origin === origin ||
      (!strictRedirects && new URL(response.url).origin === "https://nikkecollection.com"),
    `${url}: unapproved response host`,
  );
  assert(response.status === status, `${url}: expected ${status}, received ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (expectedType)
    assert(contentType.includes(expectedType), `${url}: unexpected Content-Type ${contentType}`);
  return response;
}

export function assetUrlsFromHtml(html, documentUrl) {
  const urls = new Set();
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const tagName = match[1]?.toLowerCase();
    if (tagName === "link" && !/\brel=["'][^"']*stylesheet[^"']*["']/i.test(tag)) continue;
    const attribute = tagName === "script" ? "src" : "href";
    const value = tag.match(new RegExp(`\\b${attribute}=["']([^"']+)["']`, "i"))?.[1];
    if (!value || value.startsWith("data:")) continue;
    const url = new URL(value, documentUrl);
    const knownFont = Object.values(SITE_LOCALES).some(
      (locale) => locale.fontStylesheet === url.href,
    );
    if (tagName === "link" && knownFont) continue;
    if (tagName === "script" && WEB_ANALYTICS_BEACON.test(url.href)) continue;
    urls.add(url);
  }
  return [...urls];
}

export function verifyLocalizedHtml(html, locale) {
  assert(html.includes('id="app"'), `${locale.path || "/"}: React application root is missing`);
  assert(
    html.includes(`<html lang="${locale.lang}" data-locale="${locale.lang}"`),
    `${locale.path || "/"}: localized document language is missing`,
  );
  assert(html.includes(`<title>${locale.title}</title>`), `${locale.path || "/"}: title mismatch`);
  assert(
    html.includes(`<link rel="canonical" href="${locale.canonical}" />`),
    `${locale.path || "/"}: canonical URL mismatch`,
  );
  for (const canonical of canonicalUrls) {
    assert(
      html.includes(`rel="alternate"`) && html.includes(`href="${canonical}"`),
      `${locale.path || "/"}: missing hreflang URL ${canonical}`,
    );
  }
  assert(
    html.includes('hreflang="x-default" href="https://nikkecollection.com/"'),
    `${locale.path || "/"}: x-default is missing`,
  );
  assert(
    html.includes('id="site-structured-data"') && html.includes('"@type":"SoftwareApplication"'),
    `${locale.path || "/"}: SoftwareApplication JSON-LD is missing`,
  );
}

export async function smokePages(pageUrl, expectedRevision, fetchImpl = fetch) {
  assert(/^[0-9a-f]{40}$/.test(expectedRevision), "Expected a full lowercase Git commit SHA");
  const baseUrl = new URL(pageUrl);
  const get = (url, type) =>
    checkedFetch(url, type, {
      origin: baseUrl.origin,
      revision: expectedRevision,
      fetchImpl,
    });
  const allAssetUrls = new Map();
  for (const locale of localePages) {
    const documentUrl = new URL(locale.path, baseUrl);
    const response = await get(documentUrl, "text/html");
    const html = await response.text();
    verifyLocalizedHtml(html, locale);

    const assetUrls = assetUrlsFromHtml(html, documentUrl);
    assert(assetUrls.length >= 2, `${locale.path || "/"}: expected module and stylesheet assets`);
    for (const assetUrl of assetUrls) allAssetUrls.set(assetUrl.toString(), assetUrl);
  }

  let revisionFound = false;
  for (const assetUrl of allAssetUrls.values()) {
    const isScript = assetUrl.pathname.endsWith(".js");
    const response = await get(assetUrl, isScript ? "javascript" : "text/css");
    const body = await response.text();
    assert(body.length > 0, `${assetUrl}: asset is empty`);
    if (isScript && body.includes(expectedRevision)) revisionFound = true;
  }
  assert(revisionFound, `entry assets do not contain deployed revision ${expectedRevision}`);

  const wasmUrl = new URL("solver_rs.wasm", baseUrl);
  const wasmResponse = await get(wasmUrl, "application/wasm");
  const wasm = new Uint8Array(await wasmResponse.arrayBuffer());
  assert(wasm.length > 8, "solver WASM is empty");
  assert(
    wasm[0] === 0x00 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d,
    "solver WASM has an invalid magic header",
  );

  const robotsResponse = await get(new URL("robots.txt", baseUrl), "text/plain");
  const robots = await robotsResponse.text();
  assert(
    robots.includes("Sitemap: https://nikkecollection.com/sitemap.xml"),
    "robots.txt does not advertise the canonical sitemap",
  );

  const sitemapResponse = await get(new URL("sitemap.xml", baseUrl), "xml");
  const sitemap = await sitemapResponse.text();
  const sitemapLocations = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  assert(
    JSON.stringify(sitemapLocations) === JSON.stringify(sitemapUrls),
    `sitemap URLs mismatch: ${JSON.stringify(sitemapLocations)}`,
  );

  for (const imagePath of ogImagePaths) {
    const imageResponse = await get(new URL(imagePath, baseUrl), "image/png");
    const image = new Uint8Array(await imageResponse.arrayBuffer());
    assert(image.length > 5_000, `${imagePath}: OG image is unexpectedly small`);
  }

  return {
    assets: allAssetUrls.size,
    locales: localePages.length,
    page: baseUrl.toString(),
    revision: expectedRevision,
    wasmBytes: wasm.length,
  };
}

export async function retryPagesSmoke(
  pageUrl,
  revision,
  { smoke = smokePages, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {},
) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      return await smoke(pageUrl, revision);
    } catch (error) {
      if (attempt === 10) throw error;
      await sleep(6_000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pageUrl, revision] = process.argv.slice(2);
  if (!pageUrl || !revision) throw new Error("Usage: npm run smoke:pages -- <page-url> <sha>");
  console.log(JSON.stringify(await retryPagesSmoke(pageUrl, revision)));
}
