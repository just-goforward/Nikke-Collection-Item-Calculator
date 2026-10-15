import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Manifest } from "vite";
import { SITE_LOCALE_ORDER, SITE_LOCALES, siteLocaleUrl } from "../shared/siteLocales.ts";
import type { CertifiedBundleBoundary } from "./certified-bundle-boundary.ts";
import { localizedSeoBlock, renderSitemap } from "./localized-pages.ts";

const RECEIPT = ".vite/site-production.json";
const ROOT = resolve(import.meta.dirname, "..");
const IMMUTABLE = "Cache-Control: public, max-age=31536000, immutable";

async function filesIn(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const paths = await Promise.all(
    entries.map((entry) => {
      const path = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Production assets cannot be symlinks: ${path}`);
      return entry.isDirectory() ? filesIn(directory, `${path}/`) : [path];
    }),
  );
  return paths.flat().sort();
}

function statsScript(html: string): string {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].filter((match) =>
    match[1]?.includes("window.COLLECTION_STATS_CONFIG"),
  );
  if (scripts.length !== 1) throw new Error("Expected exactly one stats configuration script");
  return (scripts[0]?.[1] ?? "").replace(/\r\n?/g, "\n").trim();
}

export function assertProductionHtml(html: string, path: string, sourceConfig: string): void {
  if (
    /data-site-staging|COLLECTION_ACCOUNT_CONFIG|Content-Security-Policy/i.test(html) ||
    /searchParams\.set\(\s*["']statsEnv/.test(html)
  ) {
    throw new Error(`Staging or header policy contamination in ${path}`);
  }
  const locale = SITE_LOCALE_ORDER.find(
    (value) => `${SITE_LOCALES[value].path.slice(1)}index.html` === path,
  );
  if (!locale) return;
  // The ordinary Vite build preserves this inline script; normalize line endings only.
  if (statsScript(html) !== sourceConfig) {
    throw new Error(`Direct stats configuration changed in ${path}`);
  }
  if (
    !html.includes(localizedSeoBlock(locale)) ||
    !html.includes(`<html lang="${SITE_LOCALES[locale].htmlLang}"`)
  ) {
    throw new Error(`Production SEO contract changed in ${path}: ${siteLocaleUrl(locale)}`);
  }
}

export function productionHeaders(
  manifest: Manifest,
  boundary: CertifiedBundleBoundary,
  files: readonly string[],
  publicFiles: readonly string[],
): string {
  const outputs = new Set<string>();
  for (const chunk of Object.values(manifest)) {
    for (const file of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
      outputs.add(file);
    }
  }
  for (const worker of boundary.perWorker) {
    for (const chunk of worker.chunks) outputs.add(chunk.file);
  }
  // Only metadata-owned JS/CSS matching the current Vite [name]-[hash] output
  // convention qualify. Public files and unknown output formats revalidate.
  const fingerprinted = [...outputs]
    .filter(
      (file) =>
        /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(file) && !publicFiles.includes(file),
    )
    .sort();
  for (const file of outputs) {
    if (!files.includes(file)) throw new Error(`Missing emitted asset: ${file}`);
  }
  if (fingerprinted.length > 100) throw new Error("Production _headers exceeds 100 rules");
  const headers = fingerprinted.map((file) => `/${file}\n  ${IMMUTABLE}\n`).join("\n");
  if (headers.split("\n").some((line) => line.length > 2000)) {
    throw new Error("Production _headers exceeds 2000-character line limit");
  }
  return headers;
}

export async function buildSiteProduction(directory: string, check = false): Promise<void> {
  const files = await filesIn(directory);
  const source = await readFile(join(ROOT, "index.html"), "utf8");
  const sourceConfig = statsScript(source);
  for (const locale of SITE_LOCALE_ORDER) {
    const path = `${SITE_LOCALES[locale].path.slice(1)}index.html`;
    if (!files.includes(path)) throw new Error(`Missing production locale: ${path}`);
  }
  for (const path of files.filter((file) => file.endsWith(".html"))) {
    assertProductionHtml(await readFile(join(directory, path), "utf8"), path, sourceConfig);
  }
  for (const [file, expected] of [
    ["robots.txt", await readFile(join(ROOT, "public/robots.txt"), "utf8")],
    ["sitemap.xml", renderSitemap()],
  ]) {
    if ((await readFile(join(directory, file ?? ""), "utf8")) !== expected) {
      throw new Error(`Production ${file} changed`);
    }
  }
  const manifest: Manifest = JSON.parse(
    await readFile(join(directory, ".vite/manifest.json"), "utf8"),
  );
  const boundary: CertifiedBundleBoundary = JSON.parse(
    await readFile(join(directory, ".vite/certified-boundary.json"), "utf8"),
  );
  const headers = productionHeaders(manifest, boundary, files, await filesIn(join(ROOT, "public")));
  if (files.includes("_headers")) {
    const previous = await readFile(join(directory, "_headers"), "utf8");
    if (previous !== headers)
      throw new Error("Production _headers is missing, stale or contaminated");
  } else if (check) {
    throw new Error("Production _headers is missing");
  }
  if (!check) await writeFile(join(directory, "_headers"), headers);
  const hashes = await Promise.all(
    [...new Set([...files, "_headers"])]
      .filter((file) => file !== RECEIPT)
      .sort()
      .map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(join(directory, file)))
          .digest("hex"),
      ]),
  );
  const receipt = `${JSON.stringify({ version: 1, files: Object.fromEntries(hashes) }, null, 2)}\n`;
  if (check) {
    if ((await readFile(join(directory, RECEIPT), "utf8")) !== receipt) {
      throw new Error("Production artifact content changed; rebuild before deployment");
    }
  } else {
    await writeFile(join(directory, RECEIPT), receipt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Usage: node scripts/build-site-production.ts [--check]");
  }
  await buildSiteProduction(resolve("dist"), args[0] === "--check");
}
