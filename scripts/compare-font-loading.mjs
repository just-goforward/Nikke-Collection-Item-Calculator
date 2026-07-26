import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const evidenceDir = path.join(
  root,
  ".superloopy",
  "evidence",
  "frontend",
  "20260705-font-loading-comparison",
);
const variantsDir = path.join(evidenceDir, "variants");
const fontCacheDir = path.join(evidenceDir, "font-cache");
const reportsDir = path.join(evidenceDir, "lighthouse");
const LOCALES = ["ko", "ja", "en"];
const CDN_CSS_URLS = {
  ko: "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css",
  en: "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-std-dynamic-subset.min.css",
  ja: "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-jp-dynamic-subset.min.css",
};

const variants = [
  {
    id: "jsdelivr-swap",
    description: "Current production candidate: jsDelivr CSS and jsDelivr dynamic subset fonts",
    display: "swap",
    source: "current",
  },
  {
    id: "jsdelivr-fonts-optional",
    description: "Local CSS with jsDelivr dynamic subset font files and font-display optional",
    display: "optional",
    source: "cdn-fonts",
  },
  {
    id: "selfhost-swap",
    description: "Local CSS and local dynamic subset font files with font-display swap",
    display: "swap",
    source: "selfhost",
  },
  {
    id: "selfhost-optional",
    description: "Local CSS and local dynamic subset font files with font-display optional",
    display: "optional",
    source: "selfhost",
  },
];

function parseArgs() {
  const args = new Map();
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    args.set(key, value ?? "true");
  }
  return {
    formFactor: args.get("form-factor") || "mobile",
    runs: Number(args.get("runs") || 3),
    port: Number(args.get("port") || 4320),
    skipLighthouse: args.get("skip-lighthouse") === "true",
  };
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function extractFontUrls(css, cssUrl) {
  const urls = new Set();
  const matches = css.matchAll(/url\((['"]?)([^'")]+\.woff2)\1\)/g);
  for (const match of matches) {
    urls.add(new URL(match[2], cssUrl).toString());
  }
  return [...urls];
}

function fontFileName(url) {
  return path.basename(new URL(url).pathname);
}

function rewriteCss(css, cssUrl, variant, fontUrls, locale) {
  const knownUrls = new Set(fontUrls);
  return css
    .replace(/font-display:[^;]+;/g, `font-display:${variant.display};`)
    .replace(/url\((['"]?)([^'")]+\.woff2)\1\)/g, (_match, _quote, rawUrl) => {
      const url = new URL(rawUrl, cssUrl).toString();
      if (!knownUrls.has(url)) return `url(${rawUrl})`;
      const nextUrl =
        variant.source === "selfhost" ? `./fonts/pretendard/${locale}/${fontFileName(url)}` : url;
      return `url(${nextUrl})`;
    });
}

function replaceFontStylesheetUrls(html, variant) {
  let nextHtml = html;
  for (const locale of LOCALES) {
    const currentUrl = CDN_CSS_URLS[locale];
    if (!nextHtml.includes(currentUrl)) {
      throw new Error(`Could not locate the ${locale} Pretendard stylesheet URL.`);
    }
    nextHtml = nextHtml.replaceAll(currentUrl, `./font-pretendard-${locale}.css`);
  }
  if (variant.source === "selfhost") {
    nextHtml = nextHtml.replace(
      '    <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />\n',
      "",
    );
  }
  return nextHtml;
}

function forceInitialLocale(html, locale) {
  const marker = "        const fontStylesheets = {";
  if (!html.includes(marker)) throw new Error("Could not locate the locale font bootstrap.");
  return html.replace(marker, `        locale = "${locale}";\n${marker}`);
}

async function downloadFontFiles(localeAssets) {
  await mkdir(fontCacheDir, { recursive: true });
  for (const { fontUrls, locale } of localeAssets) {
    const localeDir = path.join(fontCacheDir, locale);
    await mkdir(localeDir, { recursive: true });
    for (const url of fontUrls) {
      const filePath = path.join(localeDir, fontFileName(url));
      if (existsSync(filePath)) continue;
      await writeFile(filePath, await fetchBytes(url));
    }
  }
}

async function prepareVariant(variant, initialLocale, localeAssets) {
  const dir = path.join(variantsDir, `${variant.id}-${initialLocale}`);
  await rm(dir, { recursive: true, force: true });
  await cp(distDir, dir, { recursive: true });

  const htmlPath = path.join(dir, "index.html");
  const html = await readFile(htmlPath, "utf8");
  const localeHtml = forceInitialLocale(html, initialLocale);
  if (variant.source === "current") {
    await writeFile(htmlPath, localeHtml);
    return dir;
  }

  const nextHtml = replaceFontStylesheetUrls(localeHtml, variant);
  await writeFile(htmlPath, nextHtml);
  for (const asset of localeAssets) {
    await writeFile(
      path.join(dir, `font-pretendard-${asset.locale}.css`),
      rewriteCss(asset.css, asset.cssUrl, variant, asset.fontUrls, asset.locale),
    );
  }

  if (variant.source !== "selfhost") return dir;

  const fontDir = path.join(dir, "fonts", "pretendard");
  for (const asset of localeAssets) {
    const localeDir = path.join(fontDir, asset.locale);
    await mkdir(localeDir, { recursive: true });
    for (const url of asset.fontUrls) {
      await cp(
        path.join(fontCacheDir, asset.locale, fontFileName(url)),
        path.join(localeDir, fontFileName(url)),
      );
    }
  }
  return dir;
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function shouldGzip(filePath) {
  return /\.(?:html|css|js|json|txt|svg)$/.test(filePath);
}

function serveStatic(rootDir, port) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
      const decodedPath = decodeURIComponent(url.pathname);
      const target = path.resolve(rootDir, `.${decodedPath === "/" ? "/index.html" : decodedPath}`);
      if (!target.startsWith(rootDir)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      let body = await readFile(target);
      const headers = {
        "Cache-Control": "no-store",
        "Content-Type": contentType(target),
      };
      if (shouldGzip(target) && request.headers["accept-encoding"]?.includes("gzip")) {
        body = gzipSync(body);
        headers["Content-Encoding"] = "gzip";
        headers.Vary = "Accept-Encoding";
      }
      response.writeHead(200, {
        ...headers,
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end("Not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stdout}\n${stderr}`));
    });
  });
}

function runNpmExecutable(executable, args) {
  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) {
    throw new Error("Run this script through `npm run perf:fonts` so npm_execpath is available.");
  }
  return run(process.execPath, [npmCliPath, "exec", "--yes", "--", executable, ...args]);
}

async function runLighthouse(url, outputPath, formFactor) {
  const isMobile = formFactor === "mobile";
  const args = [
    url,
    "--output=json",
    `--output-path=${outputPath}`,
    "--only-categories=performance",
    "--throttling-method=devtools",
    "--throttling.cpuSlowdownMultiplier=4",
    "--chrome-flags=--headless=new --incognito --disable-extensions",
    `--form-factor=${formFactor}`,
    `--screenEmulation.mobile=${isMobile}`,
    `--screenEmulation.width=${isMobile ? 390 : 1310}`,
    `--screenEmulation.height=${isMobile ? 844 : 1069}`,
    "--screenEmulation.deviceScaleFactor=1",
  ];
  try {
    await runNpmExecutable("lighthouse", args);
  } catch (error) {
    if (existsSync(outputPath)) {
      console.warn(
        `Lighthouse wrote ${path.relative(root, outputPath)} but exited non-zero during cleanup.`,
      );
      return;
    }
    throw error;
  }
}

function readMetric(audits, id) {
  return Number(audits[id]?.numericValue ?? 0);
}

function summarizeReport(report, variantId, locale, runIndex) {
  const audits = report.audits;
  const requests = audits["network-requests"]?.details?.items || [];
  const fontRequests = requests.filter((item) => /\.(?:woff2|css)(?:\?|$)/i.test(item.url || ""));
  const pretendardRequests = fontRequests.filter((item) => /pretendard/i.test(item.url || ""));
  return {
    variantId,
    locale,
    runIndex,
    score: Math.round((report.categories.performance.score || 0) * 100),
    fcpMs: readMetric(audits, "first-contentful-paint"),
    lcpMs: readMetric(audits, "largest-contentful-paint"),
    tbtMs: readMetric(audits, "total-blocking-time"),
    cls: readMetric(audits, "cumulative-layout-shift"),
    speedIndexMs: readMetric(audits, "speed-index"),
    fontRequestCount: pretendardRequests.length,
    fontTransferBytes: pretendardRequests.reduce(
      (sum, item) => sum + Number(item.transferSize || 0),
      0,
    ),
    fontResourceBytes: pretendardRequests.reduce(
      (sum, item) => sum + Number(item.resourceSize || 0),
      0,
    ),
    largestFontRequests: pretendardRequests
      .map((item) => ({
        transferSize: Number(item.transferSize || 0),
        url: item.url,
      }))
      .sort((a, b) => b.transferSize - a.transferSize)
      .slice(0, 5),
  };
}

function median(values, key) {
  const sorted = [...values].sort((a, b) => a[key] - b[key]);
  return sorted[Math.floor(sorted.length / 2)]?.[key] ?? 0;
}

function medianSummary(rows) {
  const byVariant = new Map();
  for (const row of rows) {
    const key = `${row.variantId}:${row.locale}`;
    byVariant.set(key, [...(byVariant.get(key) || []), row]);
  }
  return [...byVariant.entries()].map(([key, items]) => ({
    key,
    variantId: items[0]?.variantId,
    locale: items[0]?.locale,
    runs: items.length,
    score: median(items, "score"),
    fcpMs: median(items, "fcpMs"),
    lcpMs: median(items, "lcpMs"),
    tbtMs: median(items, "tbtMs"),
    cls: median(items, "cls"),
    speedIndexMs: median(items, "speedIndexMs"),
    fontRequestCount: median(items, "fontRequestCount"),
    fontTransferBytes: median(items, "fontTransferBytes"),
    fontResourceBytes: median(items, "fontResourceBytes"),
  }));
}

async function main() {
  const options = parseArgs();
  if (!existsSync(distDir)) throw new Error("dist does not exist. Run npm run build first.");
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });

  const localeAssets = await Promise.all(
    LOCALES.map(async (locale) => {
      const cssUrl = CDN_CSS_URLS[locale];
      const css = await fetchText(cssUrl);
      const fontUrls = extractFontUrls(css, cssUrl);
      await writeFile(path.join(evidenceDir, `pretendard-${locale}.css`), css);
      return { css, cssUrl, fontUrls, locale };
    }),
  );
  await downloadFontFiles(localeAssets);

  const variantDirs = new Map();
  for (const variant of variants) {
    for (const locale of LOCALES) {
      const key = `${variant.id}:${locale}`;
      variantDirs.set(key, await prepareVariant(variant, locale, localeAssets));
    }
  }

  const rows = [];
  const servers = [];
  try {
    let serverIndex = 0;
    for (const variant of variants) {
      for (const locale of LOCALES) {
        const port = options.port + serverIndex;
        serverIndex += 1;
        const key = `${variant.id}:${locale}`;
        const server = await serveStatic(variantDirs.get(key), port);
        servers.push(server);
        const url = `http://127.0.0.1:${port}/?demoStats=1`;
        if (options.skipLighthouse) continue;
        for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
          const outputPath = path.join(
            reportsDir,
            `${options.formFactor}-${variant.id}-${locale}-${runIndex}.json`,
          );
          await runLighthouse(url, outputPath, options.formFactor);
          const report = JSON.parse(await readFile(outputPath, "utf8"));
          rows.push(summarizeReport(report, variant.id, locale, runIndex));
        }
      }
    }
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve);
          }),
      ),
    );
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    note: "Local test serves production build variants for a site intended for GitHub Actions and GitHub Pages deployment.",
    options,
    cssUrls: CDN_CSS_URLS,
    localeAssets: localeAssets.map((asset) => ({
      locale: asset.locale,
      cssUrl: asset.cssUrl,
      fontFaceCount: (asset.css.match(/@font-face/g) || []).length,
      fontFileCount: asset.fontUrls.length,
    })),
    variants,
    runs: rows,
    medians: medianSummary(rows),
  };
  await writeFile(
    path.join(evidenceDir, `summary-${options.formFactor}.json`),
    JSON.stringify(summary, null, 2),
  );
  await writeFile(path.join(evidenceDir, "summary-latest.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary.medians, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
