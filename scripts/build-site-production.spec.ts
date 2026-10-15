import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "vite";
import { describe, expect, it } from "vitest";
import {
  assertProductionHtml,
  buildSiteProduction,
  productionHeaders,
} from "./build-site-production";
import type { CertifiedBundleBoundary } from "./certified-bundle-boundary";
import { renderLocalizedPage, renderSitemap } from "./localized-pages";

const manifest: Manifest = {
  "index.html": {
    file: "assets/index-Abc12345.js",
    css: ["assets/index-Xyz12345.css"],
    assets: ["solver_rs.wasm", "assets/public-Abc12345.js"],
  },
};
const boundary: CertifiedBundleBoundary = {
  version: "certified-initial-boundary-v1",
  initialFiles: [],
  initialModules: [],
  certifiedFiles: [],
  perWorker: [
    {
      version: "worker-chunk-graph-v1",
      source: "src/worker.ts",
      entryFile: "assets/worker-Zyx12345.js",
      chunks: [{ file: "assets/worker-Zyx12345.js", imports: [], dynamicImports: [] }],
    },
  ],
};
const assets = [
  "assets/index-Abc12345.js",
  "assets/index-Xyz12345.css",
  "assets/worker-Zyx12345.js",
  "assets/public-Abc12345.js",
  "solver_rs.wasm",
];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "site-production-"));
  await mkdir(join(directory, ".vite"));
  await mkdir(join(directory, "assets"));
  const source = await readFile("index.html", "utf8");
  for (const locale of ["ko", "en", "ja"] as const) {
    if (locale !== "ko") await mkdir(join(directory, locale));
    await writeFile(
      join(directory, locale === "ko" ? "index.html" : `${locale}/index.html`),
      renderLocalizedPage(source, locale),
    );
  }
  await writeFile(join(directory, "robots.txt"), await readFile("public/robots.txt"));
  await writeFile(join(directory, "sitemap.xml"), renderSitemap());
  await writeFile(join(directory, ".vite/manifest.json"), JSON.stringify(manifest));
  await writeFile(join(directory, ".vite/certified-boundary.json"), JSON.stringify(boundary));
  for (const file of assets) await writeFile(join(directory, file), "fixture bytes");
  return directory;
}

describe("production site packaging", () => {
  it("grants immutable only to metadata-owned fingerprinted JS/CSS, never public or unknown files", () => {
    const headers = productionHeaders(manifest, boundary, assets, ["assets/public-Abc12345.js"]);
    expect(headers.match(/immutable/g)).toHaveLength(3);
    for (const file of assets.slice(0, 3)) expect(headers).toContain(`/${file}\n`);
    for (const value of ["public-", "solver_rs.wasm", "/*", "Content-Security-Policy", "noindex"]) {
      expect(headers).not.toContain(value);
    }
    const fixed: Manifest = { fixed: { file: "assets/fixed.js" } };
    expect(productionHeaders(fixed, { ...boundary, perWorker: [] }, ["assets/fixed.js"], [])).toBe(
      "",
    );
  });

  it("rejects missing assets and Cloudflare header rule or line overflows", () => {
    expect(() => productionHeaders(manifest, boundary, [], [])).toThrow("Missing emitted asset");
    const paths = Array.from({ length: 101 }, (_, i) => `assets/chunk${i}-Abc12345.js`);
    const many = Object.fromEntries(paths.map((file) => [file, { file }]));
    expect(() => productionHeaders(many, { ...boundary, perWorker: [] }, paths, [])).toThrow(
      "100 rules",
    );
    const file = `assets/${"x".repeat(2000)}-Abc12345.js`;
    expect(() =>
      productionHeaders({ long: { file } }, { ...boundary, perWorker: [] }, [file], []),
    ).toThrow("2000-character");
  });

  it.each([
    'data-site-staging="true"',
    "window.COLLECTION_ACCOUNT_CONFIG = { enabled: true }",
    '<meta http-equiv="Content-Security-Policy" content="default-src self">',
    'url.searchParams.set("statsEnv", "staging")',
  ])("rejects staging/header contamination in any HTML: %s", (contamination) => {
    expect(() => assertProductionHtml(contamination, "diagnostic.html", "")).toThrow(
      "contamination",
    );
  });

  it("preserves direct stats, accounts-off HTML, locale SEO and robots; checks artifact integrity", async () => {
    const directory = await fixture();
    try {
      const before = await readFile(join(directory, "en/index.html"), "utf8");
      await buildSiteProduction(directory);
      await buildSiteProduction(directory, true);
      expect(await readFile(join(directory, "en/index.html"), "utf8")).toBe(before);
      expect(before).toContain('endpoint: "https://collection-kit-stats.tbvj159.workers.dev"');
      expect(before).not.toContain("COLLECTION_ACCOUNT_CONFIG");
      expect(before).toContain('href="https://nikkecollection.com/en/"');
      expect(await readFile(join(directory, "robots.txt"), "utf8")).toBe(
        await readFile("public/robots.txt", "utf8"),
      );
      await writeFile(join(directory, assets[0] ?? ""), "changed");
      await expect(buildSiteProduction(directory, true)).rejects.toThrow("content changed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["stats", "seo", "robots", "sitemap", "headers", "locale", "asset"])(
    "rejects production contract damage: %s",
    async (damage) => {
      const directory = await fixture();
      try {
        if (damage === "stats" || damage === "seo") {
          const path = join(directory, "index.html");
          const html = await readFile(path, "utf8");
          await writeFile(
            path,
            damage === "stats"
              ? html.replace("collection-kit-stats.tbvj159", "wrong.tbvj159")
              : html.replace("index,follow,max-image-preview:large", "noindex"),
          );
        } else if (damage === "locale" || damage === "asset") {
          await rm(join(directory, damage === "locale" ? "ja/index.html" : (assets[0] ?? "")));
        } else {
          const path = damage === "headers" ? "_headers" : `${damage}.txt`;
          await writeFile(join(directory, damage === "sitemap" ? "sitemap.xml" : path), "stale");
        }
        await expect(buildSiteProduction(directory)).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
