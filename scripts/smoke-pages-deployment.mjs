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

function assetUrlsFromHtml(html) {
  const urls = new Set();
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const tagName = match[1]?.toLowerCase();
    if (tagName === "link" && !/\brel=["'][^"']*stylesheet[^"']*["']/i.test(tag)) continue;
    const attribute = tagName === "script" ? "src" : "href";
    const value = tag.match(new RegExp(`\\b${attribute}=["']([^"']+)["']`, "i"))?.[1];
    if (value && !value.startsWith("http") && !value.startsWith("data:")) {
      urls.add(new URL(value, baseUrl));
    }
  }
  return [...urls];
}

async function smokeOnce() {
  const indexResponse = await checkedFetch(baseUrl, "text/html");
  const html = await indexResponse.text();
  assert(html.includes('id="app"'), "index: React application root is missing");

  const assetUrls = assetUrlsFromHtml(html);
  assert(assetUrls.length >= 2, "index: expected module and stylesheet assets");
  let revisionFound = false;
  for (const assetUrl of assetUrls) {
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

  return {
    assets: assetUrls.length,
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
