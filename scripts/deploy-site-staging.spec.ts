import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { deploySiteStaging } from "./deploy-site-staging";

const SHA = "a".repeat(40);
const UUIDS = [
  "11111111-1111-1111-1111-111111111111",
  "22222222-2222-2222-2222-222222222222",
  "33333333-3333-3333-3333-333333333333",
];
const credentials = {
  CLOUDFLARE_API_TOKEN: "test-only-not-a-token",
  CLOUDFLARE_ACCOUNT_ID: "test-only-not-an-account",
  SITE_STAGING_PROVISIONED: "true",
};

let publicKey: string;
beforeAll(async () => {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64");
});

function fixture(
  options: {
    branch?: string;
    dirty?: string;
    fail?: string;
    changedHead?: boolean;
    dirtyAfterVerification?: boolean;
    ids?: string[];
    forecastKey?: string;
  } = {},
) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  let revisions = 0;
  let verified = false;
  return {
    calls,
    dependencies: {
      env: credentials,
      read: (path: string) =>
        path.endsWith("forecast-runtime.json")
          ? JSON.stringify({
              publicKeyBase64: options.forecastKey ?? publicKey,
            })
          : JSON.stringify({
              env: {
                staging: {
                  d1_databases: (options.ids ?? UUIDS).map((database_id) => ({ database_id })),
                },
              },
            }),
      spawn: (
        _command: string,
        args: string[],
        spawnOptions: SpawnSyncOptionsWithStringEncoding,
      ): SpawnSyncReturns<string> => {
        calls.push({ args, env: spawnOptions.env });
        let stdout = "";
        if (args[0] === "branch") stdout = options.branch ?? "next";
        if (args[0] === "status") {
          stdout =
            options.dirty ??
            (verified && options.dirtyAfterVerification ? " M tracked-source.ts" : "");
        }
        if (args[0] === "rev-parse") {
          stdout = options.changedHead && revisions++ > 0 ? "b".repeat(40) : SHA;
        }
        if (args[1] === "smoke:site-staging") verified = true;
        return {
          pid: 0,
          output: [null, stdout, ""],
          status: args.includes(options.fail ?? "__no_failure__") ? 1 : 0,
          stdout,
          stderr: "",
          signal: null,
        };
      },
    },
  };
}

describe("staging forecast public-key admission", () => {
  it.each([true, false])(
    "R1-15 rejects the placeholder before verification or deployment; dry-run=%s",
    (dryRun) => {
      const { calls, dependencies } = fixture({
        forecastKey: "REPLACE_WITH_RAW_32_BYTE_ED25519_PUBLIC_KEY_BASE64",
      });
      expect(() => deploySiteStaging(dryRun ? ["--dry-run"] : [], dependencies)).toThrow(
        "Replace the placeholder public key in site-worker/forecast-runtime.json",
      );
      expect(
        calls.every((call) => ["branch", "status", "rev-parse"].includes(call.args[0] ?? "")),
      ).toBe(true);
    },
  );

  it.each([
    "",
    "not-base64",
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"),
  ])("rejects malformed or wrong-length forecast public keys: %j", (forecastKey) => {
    const { calls, dependencies } = fixture({ forecastKey });
    expect(() => deploySiteStaging(["--dry-run"], dependencies)).toThrow("raw 32-byte Ed25519");
    expect(calls.some((call) => call.args[1] === "deploy")).toBe(false);
  });

  it("admits the committed staging publication key", () => {
    const committed = JSON.parse(readFileSync("site-worker/forecast-runtime.json", "utf8"));
    expect(committed).toMatchObject({ environment: "staging", keyId: "staging-v1" });
    const { dependencies } = fixture({ forecastKey: committed.publicKeyBase64 });
    expect(() => deploySiteStaging(["--dry-run"], dependencies)).not.toThrow();
  });
});

describe("local staging deployment", () => {
  it("cannot select production configuration, name or domain", () => {
    const { calls, dependencies } = fixture();
    for (const args of [
      ["--config", "site-worker/production.wrangler.toml"],
      ["--name", "collection-kit-site-production"],
      ["--domain", "nikkecollection.com"],
    ]) {
      expect(() => deploySiteStaging(args, dependencies)).toThrow("Usage");
    }
    expect(calls).toHaveLength(0);
    deploySiteStaging(["--dry-run"], dependencies);
    for (const call of calls) {
      expect(call.args).not.toContain("site-worker/production.wrangler.toml");
      expect(call.args).not.toContain("collection-kit-site-production");
    }
  });
  it.each(["main", "", "feature"])("rejects branch %j before verification", (branch) => {
    const { calls, dependencies } = fixture({ branch });
    expect(() => deploySiteStaging(["--dry-run"], dependencies)).toThrow("branch next");
    expect(calls).toHaveLength(1);
  });

  it.each([" M src/unrelated.ts", "?? unrelated-file", "M  staged-file"])(
    "refuses dirty status %s, even for dry runs",
    (dirty) => {
      const { calls, dependencies } = fixture({ dirty });
      expect(() => deploySiteStaging(["--dry-run"], dependencies)).toThrow("clean working tree");
      expect(calls).toHaveLength(2);
    },
  );

  it.each(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])(
    "requires environment credential %s without printing its value",
    (key) => {
      const { calls, dependencies } = fixture();
      const env = { ...credentials, [key]: " " };
      expect(() => deploySiteStaging(["--dry-run"], { ...dependencies, env })).toThrow(key);
      expect(calls.every((call) => call.args[0] !== "run" && call.args[1] !== "deploy")).toBe(true);
    },
  );

  it.each([["--env", "production"], ["--dry-run", "--dry-run"], ["--skip-checks"]])(
    "rejects unsupported arguments %j",
    (...args) => {
      const { calls, dependencies } = fixture();
      expect(() => deploySiteStaging(args, dependencies)).toThrow("Usage");
      expect(calls).toHaveLength(0);
    },
  );

  it("requires explicit provisioning and real, distinct D1 IDs for a live deployment", () => {
    const { dependencies } = fixture();
    expect(() =>
      deploySiteStaging([], {
        ...dependencies,
        env: { ...credentials, SITE_STAGING_PROVISIONED: "" },
      }),
    ).toThrow("SITE_STAGING_PROVISIONED");
    for (const ids of [
      ["placeholder", ...UUIDS.slice(1)],
      UUIDS.slice(1),
      [UUIDS[0], UUIDS[0], UUIDS[2]],
    ]) {
      const { dependencies: invalid } = fixture({ ids: ids as string[] });
      expect(() => deploySiteStaging([], invalid)).toThrow("three staging-only D1 IDs");
    }
  });

  it.each([true, false])("verifies before backend/frontend; dry-run=%s", (dryRun) => {
    const { calls, dependencies } = fixture();
    deploySiteStaging(dryRun ? ["--dry-run"] : [], dependencies);
    expect(calls.filter((call) => call.args[0] === "run").map((call) => call.args[1])).toEqual([
      "lint",
      "typecheck",
      "typecheck:site-staging",
      "build:site-staging",
      "check:site-staging",
      "smoke:site-staging",
      "check:site-staging",
      "check:site-staging",
    ]);
    const deployments = calls.filter((call) => call.args[1] === "deploy");
    expect(deployments.map((call) => call.args[3])).toEqual([
      "site-worker/personal-data-staging.wrangler.json",
      "site-worker/wrangler.toml",
    ]);
    for (const call of calls) {
      expect(call.env?.["WRANGLER_SEND_METRICS"]).toBe("false");
      if (deployments.includes(call)) {
        expect(call.args).toEqual([
          expect.stringContaining("wrangler"),
          "deploy",
          "--config",
          call.args[3],
          "--env",
          "staging",
          "--tag",
          SHA,
          "--message",
          `Site staging ${SHA}`,
          ...(dryRun ? ["--dry-run"] : []),
        ]);
        expect(call.env?.["CLOUDFLARE_API_TOKEN"]).toBe(credentials.CLOUDFLARE_API_TOKEN);
      } else {
        expect(call.env?.["CLOUDFLARE_API_TOKEN"]).toBeUndefined();
        expect(call.env?.["CLOUDFLARE_ACCOUNT_ID"]).toBeUndefined();
      }
    }
    const unitTests = calls.find((call) => call.args[0]?.endsWith("vitest.mjs"));
    expect(unitTests?.args).toEqual([
      expect.any(String),
      "run",
      "--configLoader",
      "runner",
      "scripts/deploy-site-staging.spec.ts",
      "scripts/build-site-staging.spec.ts",
      "scripts/site-worker.spec.ts",
    ]);
  });

  it.each([
    "lint",
    "typecheck",
    "typecheck:site-staging",
    "scripts/deploy-site-staging.spec.ts",
    "build:site-staging",
    "check:site-staging",
    "smoke:site-staging",
  ])("stops before Wrangler when %s fails", (fail) => {
    const { calls, dependencies } = fixture({ fail });
    expect(() => deploySiteStaging(["--dry-run"], dependencies)).toThrow("Staging stopped");
    expect(calls.filter((call) => call.args[1] === "deploy")).toHaveLength(0);
  });

  it("never deploys the frontend after backend failure", () => {
    const { calls, dependencies } = fixture({
      fail: "site-worker/personal-data-staging.wrangler.json",
    });
    expect(() => deploySiteStaging(["--dry-run"], dependencies)).toThrow("Staging stopped");
    expect(calls.filter((call) => call.args[1] === "deploy")).toHaveLength(1);
  });

  it.each([{ changedHead: true }, { dirtyAfterVerification: true }])(
    "rejects repository drift during verification: %j",
    (options) => {
      const { calls, dependencies } = fixture(options);
      expect(() => deploySiteStaging(["--dry-run"], dependencies)).toThrow();
      expect(calls.filter((call) => call.args[1] === "deploy")).toHaveLength(0);
    },
  );

  it("removes GitHub staging deployment from the dynamically discovered workflow inventory", () => {
    expect(readdirSync(".github/workflows")).not.toContain("site-staging.yml");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(packageJson.scripts["deploy:site-staging"]).toBe("node scripts/deploy-site-staging.ts");
    const config = JSON.parse(
      readFileSync("site-worker/personal-data-staging.wrangler.json", "utf8"),
    );
    expect(config.env.staging.name).toBe("collection-kit-personal-data-staging");
    expect(config.env.staging.vars.SITE_ORIGIN).toBe("https://staging.nikkecollection.com");
    const bindings = config.env.staging.d1_databases.map(
      (database: { binding: string }) => database.binding,
    );
    expect(bindings).toEqual(["PERSONAL_DB", "PRIVACY_CONTROL_DB", "PUBLIC_AGGREGATE_DB"]);
    expect(config.env.staging.vars.PUBLICATION_ENABLED).toBe("false");
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.env.staging.vars.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });
});
