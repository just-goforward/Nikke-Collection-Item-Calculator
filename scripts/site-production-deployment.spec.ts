import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateWorkflowSource } from "./check-workflow-hardening";
import {
  assertBuiltRevision,
  assertVerificationCredentialsAbsent,
  productionCandidate,
  run,
  siteDeploymentArguments,
} from "./site-production-deployment";

const sha = "a".repeat(40);
const versionId = "12345678-1234-1234-1234-123456789abc";
const config = readFileSync("site-worker/production.wrangler.toml", "utf8");
const candidate = {
  sha,
  checkout: sha,
  ref: "refs/heads/main",
  repository: "owner/repo",
  workflowRef: "owner/repo/.github/workflows/site-worker-promote.yml@refs/heads/main",
  inMainHistory: true,
  mode: "publish",
};
const payload = Buffer.from("verified tar fixture");

function harness(
  mode = "publish",
  state = JSON.stringify({ versions: [{ version_id: versionId, percentage: 100 }] }),
) {
  const env: NodeJS.ProcessEnv = {
    DEPLOY_SHA: sha,
    SITE_DEPLOY_MODE: mode,
    GITHUB_SHA: "b".repeat(40),
    GITHUB_REF: candidate.ref,
    GITHUB_WORKFLOW_REF: candidate.workflowRef,
    GITHUB_REPOSITORY: candidate.repository,
    GITHUB_OUTPUT: "output",
    GITHUB_STEP_SUMMARY: "summary",
    R65_NPM_CLI: resolve("pinned-npm-cli.js"),
    SITE_URL: "https://nikkecollection.com",
    SITE_ARTIFACT_PATH: "archive",
    SITE_ARTIFACT_DIGEST: "c".repeat(64),
    SITE_PAYLOAD_DIGEST: createHash("sha256").update(payload).digest("hex"),
    WRANGLER_OUTPUT_FILE_PATH: "ndjson",
  };
  const files: Record<string, Buffer> = {
    archive: payload,
    "site-worker/production.wrangler.toml": Buffer.from(config),
    "dist/.vite/manifest.json": Buffer.from(
      JSON.stringify({
        "index.html": { file: "assets/index-abcdefgh.js", isEntry: true },
      }),
    ),
    // Shape observed in dist/assets/index-gmPbWxVi.js from the real minified build.
    "dist/assets/index-abcdefgh.js": Buffer.from(
      `document.documentElement.dataset.buildRevision=\`${sha}\`,Se()`,
    ),
    ndjson: Buffer.from(
      JSON.stringify({
        type: "deploy",
        version: 1,
        worker_name: "collection-kit-site-production",
        wrangler_environment: "",
        version_id: versionId,
      }),
    ),
  };
  const execute = vi.fn(
    (_command: string, args: string[], _options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === "merge-base") return "";
      if (args[0] === "rev-parse") return sha;
      if (args[1] === "deployments") return state;
      if (args[1] === "deploy" || args[1] === "run") return "";
      throw new Error(`Unexpected command ${args.join(" ")}`);
    },
  );
  const read = (path: string) => {
    const value = files[path];
    if (!value) throw new Error(`Missing fixture ${path}`);
    return value;
  };
  const append = vi.fn();
  function credentials() {
    env["CLOUDFLARE_API_TOKEN"] = "fixture-token";
    env["CLOUDFLARE_ACCOUNT_ID"] = "fixture-account";
  }
  return { env, execute, read, append, files, credentials };
}

describe("production site promotion", () => {
  it.each(["a", "A".repeat(40), `${sha};echo unsafe`, "main"])(
    "rejects malformed SHA %s",
    (bad) => {
      expect(() => productionCandidate({ ...candidate, sha: bad })).toThrow("40-hex");
    },
  );
  it.each([
    { checkout: "b".repeat(40) },
    { ref: "refs/heads/next" },
    { workflowRef: candidate.workflowRef.replace("main", "next") },
    { inMainHistory: false },
    { mode: "rollback" },
    { mode: "bootstrap" },
  ])("rejects untrusted candidates %j", (change) => {
    expect(() => productionCandidate({ ...candidate, ...change })).toThrow();
  });
  it("allows only the static production config and exact candidate deployment arguments", () => {
    expect(siteDeploymentArguments(sha, config)).toEqual([
      "deploy",
      "--config",
      "site-worker/production.wrangler.toml",
      "--env",
      "",
      "--tag",
      sha,
      "--message",
      sha,
    ]);
  });
  it.each([
    "kv_namespaces",
    "r2_buckets",
    "d1_databases",
    "services",
    "durable_objects",
    "queues",
    "ai",
    "hyperdrive",
    "tail_consumers",
    "routes",
    "env.production",
    "migrations",
  ])("rejects the %s section at runtime", (section) => {
    expect(() =>
      siteDeploymentArguments(sha, `${config}\n[${section}]\nbinding = "EXTRA"`),
    ).toThrow();
  });
  it.each([
    'route = "example.com/*"\n',
    'account_id = "extra"\n',
    "kv_namespaces = []\n",
    "extra = true\n",
    'name = "other"\n',
  ])("rejects extra or duplicate top-level configuration %s", (extra) => {
    expect(() => siteDeploymentArguments(sha, extra + config)).toThrow();
  });
  it("rejects extra vars and secret-like bindings", () => {
    expect(() =>
      siteDeploymentArguments(
        sha,
        config.replace('SITE_ENV = "production"', 'SITE_ENV = "production"\nEXTRA = "value"'),
      ),
    ).toThrow("allowlist");
  });
  it.each([
    (source: string) => source.replace('namespace_id = "419105"', 'namespace_id = "419101"'),
    (source: string) => source.replace("limit = 320", "limit = 600"),
    (source: string) => source.replace("period = 60", "period = 10"),
    (source: string) => source.replace('["STATS_HEALTH_PROBE_TOKEN"]', '["OTHER_TOKEN"]'),
    (source: string) => source.replace("[[ratelimits]]", "[ratelimits]"),
    (source: string) => `${source}\n[secrets]\nrequired = []`,
    (source: string) => `${source}\n[[ratelimits]]\nname = "EXTRA"`,
    (source: string) => source.replace("period = 60 }", "period = 60, extra = 1 }"),
  ])("pins the exact required secret and inline limiter contract %#", (change) => {
    expect(() => siteDeploymentArguments(sha, change(config))).toThrow();
  });
  it.each([
    (source: string) => source.replace('binding = "STATS"', 'binding = "OTHER"'),
    (source: string) => source.replace('service = "collection-kit-stats"', 'service = "other"'),
    (source: string) => source.replace("[[services]]", "[[queues]]"),
    (source: string) => source.replace("[[services]]", "[services]"),
    (source: string) => source.replace('service = "collection-kit-stats"', ""),
    (source: string) => source.replace('binding = "STATS"', ""),
    (source: string) =>
      `${source}\n[[services]]\nbinding = "STATS"\nservice = "collection-kit-stats"`,
    (source: string) => `${source}\nentrypoint = "extra"`,
    (source: string) => `${source}\nbinding = "STATS"`,
    (source: string) => `${source}\nservice = "collection-kit-stats"`,
    (source: string) => source.replace(/\[\[services\]\][\s\S]*$/, ""),
  ])("rejects missing, duplicate or unapproved service configuration %#", (change) => {
    expect(() => siteDeploymentArguments(sha, change(config))).toThrow();
  });
});

describe("production site artifact and deployment execution", () => {
  it("builds with candidate revision in a sanitized child environment, not the dispatch SHA", async () => {
    const h = harness();
    h.env["UNRELATED_SECRET"] = "must-not-inherit";
    await run("build", h);
    const build = h.execute.mock.calls.find(([, args]) => args.includes("build:site-production"));
    expect(build?.[2].env["GITHUB_SHA"]).toBe(sha);
    expect(build?.[2].env["UNRELATED_SECRET"]).toBeUndefined();
    expect(h.env["GITHUB_SHA"]).toBe("b".repeat(40));
  });
  it("refuses an incorrectly stamped built entry before upload/seal", async () => {
    const h = harness();
    h.files["dist/assets/index-abcdefgh.js"] = Buffer.from(
      `document.documentElement.dataset.buildRevision=\`${"b".repeat(40)}\`,Se()`,
    );
    await expect(run("build", h)).rejects.toThrow("Built entry revision");
    await expect(run("seal", h)).rejects.toThrow("Built entry revision");
    expect(h.append).not.toHaveBeenCalled();
  });
  it("seals and checks the exact downloaded payload; tampering fails closed", async () => {
    const h = harness();
    await run("seal", h);
    expect(h.append).toHaveBeenCalledWith(
      "output",
      `payload_digest=${h.env["SITE_PAYLOAD_DIGEST"]}\n`,
    );
    await run("verify-artifact", h);
    h.files["archive"] = Buffer.from("tampered");
    await expect(run("verify-artifact", h)).rejects.toThrow("digest mismatch");
  });
  it("refuses deployment credentials in verification or build", async () => {
    const h = harness();
    h.credentials();
    expect(() => assertVerificationCredentialsAbsent(h.env)).toThrow("credentials");
    await expect(run("verify", h)).rejects.toThrow("credentials");
    await expect(run("build", h)).rejects.toThrow("credentials");
  });
  it("runs publish only after its target-state guard", async () => {
    const h = harness();
    h.credentials();
    const evidence = await run("deploy", h);
    expect(evidence).toMatchObject({ sha, versionId, mode: "publish" });
    const calls = h.execute.mock.calls.map(([, args]) => args);
    expect(calls[2]).toContain("status");
    expect(calls[2]).toContain("site-worker/production.wrangler.toml");
    expect(calls[3]).toEqual([
      resolve("node_modules/wrangler/bin/wrangler.js"),
      ...siteDeploymentArguments(sha, config),
    ]);
    expect(h.append).toHaveBeenCalledWith("summary", expect.stringContaining(versionId));
  });
  it("bootstrap is unavailable in the secret-required retirement path", async () => {
    const h = harness("bootstrap", JSON.stringify([{ versions: [{ version_id: versionId }] }]));
    h.credentials();
    await expect(run("deploy", h)).rejects.toThrow("publish-only");
    expect(h.execute.mock.calls.some(([, args]) => args[1] === "deploy")).toBe(false);
  });
  it.each([10007, 10000, 10090])(
    "publish propagates Wrangler error %s without hiding missing-worker/auth failures",
    async (code) => {
      const h = harness();
      h.credentials();
      h.execute.mockImplementation((_cmd, args) => {
        if (args[0] === "merge-base") return "";
        if (args[0] === "rev-parse") return sha;
        if (args[1] === "deployments") {
          throw Object.assign(new Error("Wrangler failed"), {
            status: 1,
            stderr: `[code: ${code}]`,
          });
        }
        return "";
      });
      await expect(run("deploy", h)).rejects.toThrow("Wrangler failed");
      expect(h.execute.mock.calls.some(([, args]) => args[1] === "deploy")).toBe(false);
    },
  );
  it("publish refuses absent or malformed target state", async () => {
    const h = harness("publish", "[]");
    h.credentials();
    await expect(run("deploy", h)).rejects.toThrow();
    expect(h.execute.mock.calls.some(([, args]) => args[1] === "deploy")).toBe(false);
  });
  it("keeps build and protected deployment on separate runners with a verified artifact transfer", () => {
    const workflow = readFileSync(".github/workflows/site-worker-promote.yml", "utf8");
    expect(validateWorkflowSource(workflow)).toEqual([]);
    const verify = workflow.split("\n  verify:")[1]?.split("\n  deploy:")[0] ?? "";
    const deploy = workflow.split("\n  deploy:")[1] ?? "";
    expect(verify).not.toMatch(/secrets\.|environment:|GITHUB_SHA:/);
    expect(verify).toContain("site-production-deployment.ts build");
    expect(verify).toContain("site-production-deployment.ts seal");
    expect(deploy).toContain("name: cloudflare-site-production");
    expect(deploy).toContain("actions/download-artifact@");
    expect(deploy.indexOf("verify-artifact")).toBeLessThan(deploy.indexOf("tar -xf"));
    expect(deploy.indexOf("npm ci --ignore-scripts")).toBeLessThan(
      deploy.indexOf("check:site-production"),
    );
    expect(deploy.indexOf("check:site-production")).toBeLessThan(deploy.indexOf("secrets."));
    expect(deploy.match(/secrets\./g)).toHaveLength(3);
    expect(deploy.indexOf("Validate probe secret before publish")).toBeLessThan(
      deploy.indexOf("Deploy only the production site Worker"),
    );
    expect(deploy).toContain("if: inputs.mode == 'publish'");
  });
});

describe("minified build revision tokens", () => {
  it.each(['"', "'", "`"])("accepts a whole revision token with %s quotes", (quote) => {
    const h = harness();
    h.files["dist/assets/index-abcdefgh.js"] = Buffer.from(
      `document.documentElement.dataset.buildRevision=${quote}${sha}${quote},Se()`,
    );
    expect(() => assertBuiltRevision(sha, h.read)).not.toThrow();
  });
  it.each([`f${sha}`, `${sha}0`])("rejects a revision inside a longer hex run: %s", (value) => {
    const h = harness();
    h.files["dist/assets/index-abcdefgh.js"] = Buffer.from(
      `document.documentElement.dataset.buildRevision=\`${value}\`,Se()`,
    );
    expect(() => assertBuiltRevision(sha, h.read)).toThrow("Built entry revision");
  });
});

describe("workflow job environment contexts", () => {
  it.each([
    `    env:\n      OUTPUT: \${{ runner.temp }}`,
    `    env: { OUTPUT: \${{ runner.temp }} }`,
    `    env:\n      OUTPUT: \${{\n        runner.temp\n      }}`,
  ])("rejects runner expressions in job-level env: %s", (environment) => {
    const workflow = `jobs:\n  build:\n    timeout-minutes: 1\n${environment}\n    steps:\n      - run: echo ok`;
    expect(validateWorkflowSource(workflow)).toEqual([
      {
        line: expect.any(Number),
        message: expect.stringContaining("env cannot use runner context"),
      },
    ]);
  });

  it("permits runner expressions in step env and runner text without an expression", () => {
    const workflow = `jobs:
  build:
    timeout-minutes: 1
    env:
      LITERAL: runner.temp
      # COMMENT: \${{ runner.temp }}
    steps:
      - run: echo ok
        env:
          OUTPUT: \${{ runner.temp }}`;
    expect(validateWorkflowSource(workflow)).toEqual([]);
  });

  it.each(["pages.yml", "site-worker-promote.yml"])(
    "audits all runner expressions in %s",
    (file) => {
      expect(validateWorkflowSource(readFileSync(`.github/workflows/${file}`, "utf8"))).toEqual([]);
    },
  );
});
