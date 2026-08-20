import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SITE_ORIGIN } from "../shared/siteLocales";

describe("statistics origin configuration", () => {
  it("allows only the canonical site origin in production and staging", () => {
    const config = readFileSync(resolve(process.cwd(), "cloudflare", "wrangler.toml"), "utf8");
    const configuredOrigins = [...config.matchAll(/^ALLOWED_ORIGINS\s*=\s*"([^"]+)"$/gm)].map(
      (match) => match[1],
    );

    expect(configuredOrigins).toEqual([SITE_ORIGIN, SITE_ORIGIN]);
    expect(config).not.toContain("just-goforward.github.io");
  });
});
