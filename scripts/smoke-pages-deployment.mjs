const pageUrl = process.argv[2];
const expectedRevision = process.argv[3];

if (!pageUrl || !expectedRevision) {
  throw new Error("Usage: npm run smoke:pages -- <page-url> <expected-commit-sha>");
}
if (!/^[0-9a-f]{40}$/.test(expectedRevision)) {
  throw new Error("Expected revision must be a full lowercase Git commit SHA.");
}

const baseUrl = new URL(pageUrl);
const retryCount = 10;
const retryDelayMs = 6_000;
const localePages = [
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
const ogImagePaths = localePages.map(({ lang }) => `og/collection-calculator-${lang}.png`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkedFetch(url, expectedType) {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("deployment-smoke", expectedRevision);
  const response = await fetch(requestUrl, { cache: "no-store" });
  assert(response.status === 200, `${url}: expected 200, received ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  assert(contentType.includes(expectedType), `${url}: unexpected Content-Type ${contentType}`);
  return response;
}

function assetUrlsFromHtml(html, documentUrl) {
  const urls = new Set();
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const tagName = match[1]?.toLowerCase();
    if (tagName === "link" && !/\brel=["'][^"']*stylesheet[^"']*["']/i.test(tag)) continue;
    const attribute = tagName === "script" ? "src" : "href";
    const value = tag.match(new RegExp(`\\b${attribute}=["']([^"']+)["']`, "i"))?.[1];
    if (value && !value.startsWith("http") && !value.startsWith("data:")) {
      urls.add(new URL(value, documentUrl));
    }
  }
  return [...urls];
}

function verifyLocalizedHtml(html, locale) {
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

async function smokeOnce() {
  const allAssetUrls = new Map();
  for (const locale of localePages) {
    const documentUrl = new URL(locale.path, baseUrl);
    const response = await checkedFetch(documentUrl, "text/html");
    const html = await response.text();
    verifyLocalizedHtml(html, locale);

    const assetUrls = assetUrlsFromHtml(html, documentUrl);
    assert(assetUrls.length >= 2, `${locale.path || "/"}: expected module and stylesheet assets`);
    for (const assetUrl of assetUrls) allAssetUrls.set(assetUrl.toString(), assetUrl);
  }

  let revisionFound = false;
  for (const assetUrl of allAssetUrls.values()) {
    const isScript = assetUrl.pathname.endsWith(".js");
    const response = await checkedFetch(assetUrl, isScript ? "javascript" : "text/css");
    const body = await response.text();
    assert(body.length > 0, `${assetUrl}: asset is empty`);
    if (isScript && body.includes(expectedRevision)) revisionFound = true;
  }
  assert(revisionFound, `entry assets do not contain deployed revision ${expectedRevision}`);

  const wasmUrl = new URL("solver_rs.wasm", baseUrl);
  const wasmResponse = await checkedFetch(wasmUrl, "application/wasm");
  const wasm = new Uint8Array(await wasmResponse.arrayBuffer());
  assert(wasm.length > 8, "solver WASM is empty");
  assert(
    wasm[0] === 0x00 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d,
    "solver WASM has an invalid magic header",
  );

  const robotsResponse = await checkedFetch(new URL("robots.txt", baseUrl), "text/plain");
  const robots = await robotsResponse.text();
  assert(
    robots.includes("Sitemap: https://nikkecollection.com/sitemap.xml"),
    "robots.txt does not advertise the canonical sitemap",
  );

  const sitemapResponse = await checkedFetch(new URL("sitemap.xml", baseUrl), "xml");
  const sitemap = await sitemapResponse.text();
  const sitemapLocations = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  assert(
    JSON.stringify(sitemapLocations) === JSON.stringify(canonicalUrls),
    `sitemap URLs mismatch: ${JSON.stringify(sitemapLocations)}`,
  );

  for (const imagePath of ogImagePaths) {
    const imageResponse = await checkedFetch(new URL(imagePath, baseUrl), "image/png");
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

let lastError;
for (let attempt = 1; attempt <= retryCount; attempt += 1) {
  try {
    console.log(JSON.stringify(await smokeOnce()));
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt === retryCount) break;
    console.warn(`Pages smoke attempt ${attempt}/${retryCount} failed; retrying.`, error);
    await sleep(retryDelayMs);
  }
}

throw lastError;
