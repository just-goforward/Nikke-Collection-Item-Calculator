import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateWorkflowSource } from "./check-workflow-hardening";
import {
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
  mode: "bootstrap",
};
const payload = Buffer.from("verified tar fixture");

function harness(mode = "bootstrap", state = "[]") {
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
    "dist/assets/index-abcdefgh.js": Buffer.from(`const revision="${sha}";`),
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
    h.files["dist/assets/index-abcdefgh.js"] = Buffer.from(`"${"b".repeat(40)}"`);
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
  it.each(["bootstrap", "publish"])("runs %s only after its target-state guard", async (mode) => {
    const state =
      mode === "publish"
        ? JSON.stringify({ versions: [{ version_id: versionId, percentage: 100 }] })
        : "[]";
    const h = harness(mode, state);
    h.credentials();
    const evidence = await run("deploy", h);
    expect(evidence).toMatchObject({ sha, versionId, mode });
    const calls = h.execute.mock.calls.map(([, args]) => args);
    expect(calls[2]).toContain(mode === "publish" ? "status" : "list");
    expect(calls[2]).toContain("site-worker/production.wrangler.toml");
    expect(calls[3]).toEqual([
      resolve("node_modules/wrangler/bin/wrangler.js"),
      ...siteDeploymentArguments(sha, config),
    ]);
    expect(h.append).toHaveBeenCalledWith("summary", expect.stringContaining(versionId));
  });
  it("bootstrap refuses an existing deployment before invoking deploy", async () => {
    const h = harness("bootstrap", JSON.stringify([{ versions: [{ version_id: versionId }] }]));
    h.credentials();
    await expect(run("deploy", h)).rejects.toThrow("Bootstrap refuses");
    expect(h.execute.mock.calls.some(([, args]) => args[1] === "deploy")).toBe(false);
  });
  it.each([10007, 10000, 10090])(
    "bootstrap handles Wrangler error %s without hiding auth failures",
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
      if (code === 10007) await expect(run("deploy", h)).resolves.toMatchObject({ versionId });
      else await expect(run("deploy", h)).rejects.toThrow("Wrangler failed");
      expect(h.execute.mock.calls.some(([, args]) => args[1] === "deploy")).toBe(code === 10007);
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
    expect(deploy.match(/secrets\./g)).toHaveLength(1);
    expect(deploy).toContain("if: inputs.mode == 'publish'");
  });
});
