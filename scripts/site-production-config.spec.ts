import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("production static site configuration", () => {
  it("exposes ASSETS, SITE_ENV and the stats service, without domain provisioning", async () => {
    const source = await readFile("site-worker/production.wrangler.toml", "utf8");
    const config = source.replace(/^#.*$/gm, "");
    expect(config).toContain('name = "collection-kit-site-production"');
    expect(config).toContain('SITE_ENV = "production"');
    expect([...config.matchAll(/^binding = "([^"]+)"/gm)].map((match) => match[1])).toEqual([
      "ASSETS",
      "STATS",
    ]);
    expect([...config.matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1])).toEqual([
      "vars",
      "assets",
      "observability",
      "observability.logs",
      "[services",
    ]);
    for (const key of ["workers_dev", "preview_urls", "upload_source_maps", "invocation_logs"]) {
      expect(config).toContain(`${key} = false`);
    }
    expect(config.match(/^enabled = false$/gm)).toHaveLength(2);
    expect(config).not.toMatch(/^(?:routes?|account_id|zone_id|services|d1_databases)\s*=/m);
    expect(config).toContain('not_found_handling = "404-page"');
    for (const path of ["/api", "/auth", "/v1", "/account", "/admin"]) {
      expect(config).toContain(`"${path}"`);
      expect(config).toContain(`"${path}/*"`);
    }
    expect(config).toContain('"/robots.txt"');
  });

  it("keeps staging names, bindings, hostname and indexing policy separate", async () => {
    const config = await readFile("site-worker/wrangler.toml", "utf8");
    expect(config).toContain('name = "collection-kit-site-staging"');
    expect(config).toContain('pattern = "staging.nikkecollection.com"');
    expect(config).toContain('binding = "STATS"');
    expect(config).toContain('binding = "PERSONAL_DATA"');
    expect(config.match(/SITE_ENV = "staging"/g)).toHaveLength(2);
    expect(config).not.toContain('SITE_ENV = "production"');
  });
});
