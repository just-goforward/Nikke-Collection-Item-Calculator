import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { buildSiteStaging, stagingHeaders, stagingHtml } from "./build-site-staging";

const config =
  '<script>window.COLLECTION_STATS_CONFIG = {endpoint: "https://production.invalid"};</script>';
const html = (locale: string) =>
  `<meta name="robots" content="index,follow" /><script>window.inline = 1;</script>${config}<script type="application/ld+json">{"lang":"${locale}"}</script><script src="/assets/main.js"></script>`;

describe("staging build headers", () => {
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
      await mkdir(join(directory, "en"));
      await writeFile(join(directory, "index.html"), html("ko").replaceAll("\n", "\r\n"));
      await writeFile(join(directory, "en/index.html"), html("en"));
      await buildSiteStaging(directory);
      await buildSiteStaging(directory, true);
      expect(await readFile(join(directory, "robots.txt"), "utf8")).toBe(
        "User-agent: *\nDisallow: /\n",
      );
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
});
