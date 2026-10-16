import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STATS_SCRIPT = /<script\b[^>]*>[\s\S]*?window\.COLLECTION_STATS_CONFIG\s*=[\s\S]*?<\/script>/;
const STAGING_MARKER = 'data-site-staging="true"';
const ROBOTS = "User-agent: *\nDisallow: /\n";
const ASSETS_IGNORE = "/.vite/\n";
const STAGING_CONFIG = `<script ${STAGING_MARKER}>
// The staging host selects staging data by default; explicit demo/disabled flags survive.
(() => {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("statsEnv")) {
    url.searchParams.set("statsEnv", "staging");
    window.history.replaceState(null, "", url);
  }
})();
window.COLLECTION_STATS_CONFIG = {
  endpoint: window.location.origin,
  turnstileSiteKey: "0x4AAAAAADW5XM4osvVaOofe",
  staging: {
    endpoint: window.location.origin,
    turnstileSiteKey: "0x4AAAAAADW5XM4osvVaOofe"
  }
};
window.COLLECTION_ACCOUNT_CONFIG = { enabled: true };
</script>`;

async function htmlPaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return htmlPaths(path);
      return entry.name.endsWith(".html") ? [path] : [];
    }),
  );
  return paths.flat().sort();
}

export function stagingHtml(html: string): string {
  // Normalize HTML parser line endings before hashing the final script text.
  const normalized = html.replace(/\r\n?/g, "\n");
  const scripts = [...normalized.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)];
  const config = scripts.filter((match) => match[0].includes("window.COLLECTION_STATS_CONFIG"));
  if (config.length !== 1) throw new Error("Expected exactly one emitted stats config script.");
  return normalized
    .replace(config[0]?.[0] ?? STATS_SCRIPT, STAGING_CONFIG)
    .replace(
      /<meta name="robots" content="[^"]*"\s*\/?>/g,
      '<meta name="robots" content="noindex,nofollow" />',
    );
}

export function stagingHeaders(htmlDocuments: readonly string[]): string {
  if (htmlDocuments.length === 0) throw new Error("No emitted HTML documents found.");
  const hashes = new Set<string>();
  for (const html of htmlDocuments) {
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=/i.test(script[1] ?? "")) continue;
      hashes.add(
        `'sha256-${createHash("sha256")
          .update(script[2] ?? "")
          .digest("base64")}'`,
      );
    }
  }
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://static.cloudflareinsights.com/beacon.min.js https://static.cloudflareinsights.com/beacon.min.js/ ${[...hashes].sort().join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "font-src 'self' https://cdn.jsdelivr.net",
    "img-src 'self' data:",
    "connect-src 'self' https://challenges.cloudflare.com https://collection-kit-forecast-collector-staging.tbvj159.workers.dev",
    "worker-src 'self' blob:",
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  const result = [
    "/*",
    `  Content-Security-Policy: ${csp}`,
    "  X-Robots-Tag: noindex, nofollow",
    "  X-Frame-Options: DENY",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "",
    "/api/*",
    "  Cache-Control: no-store",
    "/auth/*",
    "  Cache-Control: no-store",
    "/v1/*",
    "  Cache-Control: no-store",
    "/account/*",
    "  Cache-Control: no-store",
    "",
  ].join("\n");
  if (result.split("\n").some((line) => line.length > 2000)) {
    throw new Error("Generated _headers exceeds Cloudflare's 2000-character line limit.");
  }
  return result;
}

export async function buildSiteStaging(directory: string, check = false): Promise<void> {
  const paths = await htmlPaths(directory);
  const emitted = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const documents = emitted.map(stagingHtml);
  const headers = stagingHeaders(documents);
  if (check) {
    if (documents.some((html, index) => html !== emitted[index])) {
      throw new Error("Staging HTML is missing or stale; run the staging build step.");
    }
    if ((await readFile(join(directory, "_headers"), "utf8")) !== headers) {
      throw new Error("Staging CSP does not match final emitted HTML.");
    }
    if ((await readFile(join(directory, "robots.txt"), "utf8")) !== ROBOTS) {
      throw new Error("Staging robots.txt is missing or stale.");
    }
    if ((await readFile(join(directory, ".assetsignore"), "utf8")) !== ASSETS_IGNORE) {
      throw new Error("Staging .assetsignore must exclude all .vite build metadata.");
    }
    return;
  }
  await Promise.all(paths.map((path, index) => writeFile(path, documents[index] ?? "", "utf8")));
  await writeFile(join(directory, "_headers"), headers, "utf8");
  await writeFile(join(directory, "robots.txt"), ROBOTS, "utf8");
  await writeFile(join(directory, ".assetsignore"), ASSETS_IGNORE, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some((arg) => arg !== "--check")) {
    throw new Error("Usage: node scripts/build-site-staging.ts [--check]");
  }
  await buildSiteStaging(resolve("dist"), process.argv.includes("--check"));
}
