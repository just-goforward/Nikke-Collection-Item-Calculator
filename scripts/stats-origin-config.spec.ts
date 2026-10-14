import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SITE_ORIGIN } from "../shared/siteLocales";

describe("statistics origin configuration", () => {
  it("allows only the configured site origins for each environment", () => {
    const config = readFileSync(resolve(process.cwd(), "cloudflare", "wrangler.toml"), "utf8");
    const environments = [
      ["vars", [SITE_ORIGIN]],
      ["env.staging.vars", [SITE_ORIGIN, "https://staging.nikkecollection.com"]],
    ] as const;

    for (const [sectionName, expectedOrigins] of environments) {
      const section = config.split(`[${sectionName}]`)[1]?.split(/^\[/m)[0] ?? "";
      const configuredOrigins = [...section.matchAll(/^ALLOWED_ORIGINS\s*=\s*"([^"]+)"\r?$/gm)].map(
        (match) => match[1],
      );

      expect(configuredOrigins, sectionName).toEqual([expectedOrigins.join(",")]);
    }
    expect(config).not.toContain("just-goforward.github.io");
  });
});
