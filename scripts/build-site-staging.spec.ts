import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import staging from "../site-worker/forecast-runtime.json";
import { buildSiteStaging, stagingHeaders, stagingHtml } from "./build-site-staging";
import { stagingForecastBuildEnv } from "./forecast-runtime-build";

const config =
  '<script>window.COLLECTION_STATS_CONFIG = {endpoint: "https://production.invalid"};</script>';
const html = (locale: string) =>
  `<meta name="robots" content="index,follow" /><script>window.inline = 1;</script>${config}<script type="application/ld+json">{"lang":"${locale}"}</script><script src="/assets/main.js"></script>`;

async function stagingMetadata(directory: string) {
  await mkdir(join(directory, ".vite"));
  await writeFile(
    join(directory, ".vite/forecast-runtime.json"),
    JSON.stringify({
      version: 1,
      mode: "staging",
      keyId: staging.keyId,
      publicKeyBase64: staging.publicKeyBase64,
    }),
  );
}

describe("staging build headers", () => {
  it("pins the staging compilation to reviewed public-key config, not inherited production flags", () => {
    expect(
      stagingForecastBuildEnv({
        VITE_FORECAST_RUNTIME: "off",
        VITE_FORECAST_PUBLIC_KEY_ID: "wrong",
      }),
    ).toMatchObject({
      VITE_FORECAST_RUNTIME: "staging",
      VITE_FORECAST_PUBLIC_KEY_ID: staging.keyId,
      VITE_FORECAST_PUBLIC_KEY_BASE64: staging.publicKeyBase64,
    });
  });
  it("hashes every final inline script including all localized JSON-LD, not external scripts", () => {
    const documents = ["ko", "en", "ja"].map((locale) => stagingHtml(html(locale)));
    const headers = stagingHeaders(documents);
    const expectedScripts = [
      "window.inline = 1;",
      ...["ko", "en", "ja"].map((locale) => `{"lang":"${locale}"}`),
      documents[0]?.match(/<script data-site-staging="true">([\s\S]*?)<\/script>/)?.[1] ?? "",
    ];
    for (const script of expectedScripts) {
      const hash = createHash("sha256").update(script).digest("base64");
      expect(headers).toContain(`'sha256-${hash}'`);
    }
    expect(headers.match(/'sha256-/g)).toHaveLength(5);
    expect(headers).toContain("'wasm-unsafe-eval'");
    expect(headers).toContain("https://challenges.cloudflare.com");
    expect(headers).toContain("https://cdn.jsdelivr.net");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).not.toContain("'unsafe-eval'");
    const scriptPolicy = headers.match(/script-src ([^;]+)/)?.[1];
    expect(scriptPolicy).not.toContain("'unsafe-inline'");
    expect(scriptPolicy).not.toContain("'nonce-");
    // Cloudflare Web Analytics automatic injection: the documented exact beacon plus a path-prefix
    // source for the versioned beacon.min.js/v… form; beacons go to same-origin /cdn-cgi/rum.
    const beaconSources = scriptPolicy
      ?.split(" ")
      .filter((source) => /cloudflareinsights/.test(source));
    expect(beaconSources).toEqual([
      "https://static.cloudflareinsights.com/beacon.min.js",
      "https://static.cloudflareinsights.com/beacon.min.js/",
    ]);
    expect(headers.match(/cloudflareinsights/g)).toHaveLength(2);
    expect(headers).toContain("connect-src 'self'");
    expect(headers).toContain("/v1/*\n  Cache-Control: no-store");
    expect(headers.split("\n").every((line) => line.length <= 2000)).toBe(true);
    expect(documents[0]).toContain("endpoint: window.location.origin");
    expect(documents[0]).not.toContain("production.invalid");
    for (const document of documents) {
      expect(document).toContain("window.COLLECTION_ACCOUNT_CONFIG = { enabled: true };");
    }
  });

  it("keeps the account config out of production dist HTML in every locale", async () => {
    const directory = await mkdtemp(join(tmpdir(), "site-production-"));
    try {
      await build({
        configFile: "vite.config.ts",
        configLoader: "native",
        build: { outDir: directory },
      });
      const manifest = JSON.parse(await readFile(join(directory, ".vite/manifest.json"), "utf8"));
      expect(manifest).not.toHaveProperty("src/lib/runtimeForecast.ts");
      expect(manifest).not.toHaveProperty("src/certifiedUi/RuntimeForecastNotice.tsx");
      for (const path of ["index.html", "en/index.html", "ja/index.html"]) {
        const emitted = await readFile(join(directory, path), "utf8");
        expect(emitted).not.toContain("COLLECTION_ACCOUNT_CONFIG");
        expect(emitted).not.toContain('data-site-staging="true"');
        expect(stagingHtml(emitted)).toContain(
          "window.COLLECTION_ACCOUNT_CONFIG = { enabled: true };",
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails closed for missing HTML, missing config and oversized headers", () => {
    expect(() => stagingHeaders([])).toThrow("No emitted HTML");
    expect(() => stagingHtml("<html></html>")).toThrow("exactly one");
    expect(() =>
      stagingHeaders(Array.from({ length: 40 }, (_, i) => `<script>window.x=${i}</script>`)),
    ).toThrow("2000-character");
  });

  it("writes once, checks idempotently, and rejects stale hashes after any emitted change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "site-staging-"));
    try {
      await stagingMetadata(directory);
      await mkdir(join(directory, "en"));
      await writeFile(join(directory, "index.html"), html("ko").replaceAll("\n", "\r\n"));
      await writeFile(join(directory, "en/index.html"), html("en"));
      await buildSiteStaging(directory);
      await buildSiteStaging(directory, true);
      expect(await readFile(join(directory, "robots.txt"), "utf8")).toBe(
        "User-agent: *\nDisallow: /\n",
      );
      expect(await readFile(join(directory, ".assetsignore"), "utf8")).toBe("/.vite/\n");
      const emitted = await readFile(join(directory, "en/index.html"), "utf8");
      await writeFile(
        join(directory, "en/index.html"),
        emitted.replace("window.inline = 1", "window.inline = 2"),
      );
      await expect(buildSiteStaging(directory, true)).rejects.toThrow("CSP does not match");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([null, "", "/.vite/manifest.json\n", "/.vite/\n!/.vite/manifest.json\n"])(
    "rejects missing or incomplete metadata exclusions in check mode: %j",
    async (contents) => {
      const directory = await mkdtemp(join(tmpdir(), "site-staging-"));
      try {
        await stagingMetadata(directory);
        await writeFile(join(directory, "index.html"), html("ko"));
        await buildSiteStaging(directory);
        await buildSiteStaging(directory, true);
        const path = join(directory, ".assetsignore");
        if (contents === null) await rm(path);
        else await writeFile(path, contents);
        await expect(buildSiteStaging(directory, true)).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
