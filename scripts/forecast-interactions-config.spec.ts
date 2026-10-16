import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const production = readFileSync("forecast-interactions/wrangler.toml", "utf8").replace(
  /\r\n/g,
  "\n",
);
const staging = readFileSync("forecast-interactions/staging.wrangler.toml", "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("isolated staging interactions configuration", () => {
  it("preserves the existing production router config from c7740b8", () => {
    expect(createHash("sha256").update(production).digest("hex")).toBe(
      "de5fbc84892f1269d5329104d989927cb5dd359ce3d12247b08660160c03eaaf",
    );
  });

  it("changes only the deployment name and removes the production DB binding", () => {
    expect(staging).toBe(
      production
        .replace(
          'name = "collection-kit-forecast-interactions"',
          'name = "collection-kit-forecast-interactions-staging"',
        )
        .replace(
          '[[d1_databases]]\nbinding = "PRODUCTION_FORECAST_DB"\ndatabase_name = "collection-kit-forecast-collector"\ndatabase_id = "2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853"\n\n',
          "",
        ),
    );
    expect([...staging.matchAll(/^binding = "([^"]+)"$/gm)].map((match) => match[1])).toEqual([
      "STAGING_FORECAST_DB",
      "USAGE_GUARD_DB",
    ]);
    expect(staging).toContain('database_id = "49b5dc06-37ae-4245-896c-daea98562ed8"');
    expect(staging).toContain('database_id = "49b7f966-f4e8-4c2d-8453-279415737054"');
    expect(staging).toContain('STAGING_PUBLICATION_MODE = "off"');
    expect(staging).toContain('PRODUCTION_PUBLICATION_MODE = "off"');
    expect(staging).toContain('PRODUCTION_MUTATIONS_ENABLED = "false"');
    expect(staging).not.toContain("PRODUCTION_FORECAST_DB");
    expect(staging).not.toContain("2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853");
    expect(staging).not.toContain("FORECAST_PUBLICATION_SIGNING_KEY");
  });
});
