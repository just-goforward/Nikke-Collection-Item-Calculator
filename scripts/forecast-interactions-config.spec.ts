import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync("forecast-interactions/wrangler.toml", "utf8").replace(/\r\n/g, "\n");
const [production = "", stagingEnvironment = ""] = config.split("[env.staging]");
const staging = readFileSync("forecast-interactions/staging.wrangler.toml", "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("isolated staging interactions configuration", () => {
  it("isolates the named staging environment and inherits the 10ms CPU limit", () => {
    expect(config).toContain("[limits]\ncpu_ms = 10");
    expect(stagingEnvironment).toContain('FORECAST_ENVIRONMENT = "staging"');
    expect(stagingEnvironment).toContain('name = "collection-kit-forecast-interactions-staging"');
    expect([...stagingEnvironment.matchAll(/^binding = "([^"]+)"$/gm)].map((m) => m[1])).toEqual([
      "STAGING_FORECAST_DB",
      "USAGE_GUARD_DB",
    ]);
    expect(stagingEnvironment).not.toContain("PRODUCTION_FORECAST_DB");
    expect(stagingEnvironment).not.toContain("2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853");
  });
  it("preserves the existing production router config from c7740b8", () => {
    expect(createHash("sha256").update(production).digest("hex")).toBe(
      "de5fbc84892f1269d5329104d989927cb5dd359ce3d12247b08660160c03eaaf",
    );
  });

  it("changes only the deployment name, staging app identity and removes the production DB binding", () => {
    // Public identifiers of the staging-only Discord app and the staging-v1 publication key
    // trusted by site-worker/forecast-runtime.json. Secrets never belong in this file.
    const stagingIdentity = {
      DISCORD_PUBLIC_KEY: "ac93bf021478a9bb6f2c610f7b5402610633007d4728d449a5b109bcdbefb3ae",
      DISCORD_APPLICATION_ID: "1542496100525805668",
      DISCORD_GUILD_ID: "1542497533417496619",
      DISCORD_FORECAST_APPROVER_USER_ID: "1539627186212839517",
      DISCORD_APPROVAL_CHANNEL_ID: "1542497534373662802",
      DISCORD_ALERT_CHANNEL_ID: "1542497534373662802",
      DISCORD_ACTIVITY_CHANNEL_ID: "1542497534373662802",
      FORECAST_PUBLICATION_KEY_ID: "staging-v1",
    };
    let expected = production;
    for (const [name, value] of Object.entries(stagingIdentity)) {
      expected = expected.replace(`${name} = "unset"`, `${name} = "${value}"`);
    }
    expect(JSON.parse(readFileSync("site-worker/forecast-runtime.json", "utf8")).keyId).toBe(
      stagingIdentity.FORECAST_PUBLICATION_KEY_ID,
    );
    expect(staging).toBe(
      expected
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
