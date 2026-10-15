import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateWorkflowSource } from "./check-workflow-hardening";
import {
  assertVerificationCredentialsAbsent,
  productionCandidate,
  siteDeploymentArguments,
} from "./site-production-deployment";

const sha = "a".repeat(40);
const candidate = {
  sha,
  checkout: sha,
  ref: "refs/heads/main",
  repository: "owner/repo",
  workflowRef: "owner/repo/.github/workflows/site-worker-promote.yml@refs/heads/main",
  inMainHistory: true,
  mode: "bootstrap",
};
const config = `name = "collection-kit-site-production"
workers_dev = false
preview_urls = false
[vars]
SITE_ENV = "production"
`;

describe("production site promotion", () => {
  it("fails verification if deployment credentials leak into its environment", () => {
    expect(() => assertVerificationCredentialsAbsent({ GITHUB_SHA: sha })).not.toThrow();
    for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
      expect(() => assertVerificationCredentialsAbsent({ [key]: "fixture" })).toThrow(
        "credentials must be absent",
      );
    }
  });

  it.each(["a", "A".repeat(40), `${sha};echo unsafe`, "main"])(
    "rejects malformed SHA %s",
    (bad) => {
      expect(() => productionCandidate({ ...candidate, sha: bad })).toThrow("40-hex");
    },
  );

  it.each([
    { checkout: "b".repeat(40) },
    { ref: "refs/heads/next" },
    { workflowRef: "owner/repo/.github/workflows/site-worker-promote.yml@refs/heads/next" },
    { inMainHistory: false },
    { mode: "rollback" },
  ])("rejects untrusted or mismatched candidate %j", (change) => {
    expect(() => productionCandidate({ ...candidate, ...change })).toThrow();
  });

  it.each(["bootstrap", "publish"])("builds and tags the exact candidate in %s", (mode) => {
    expect(productionCandidate({ ...candidate, mode }).buildEnvironment.GITHUB_SHA).toBe(sha);
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
    "\nroutes = []",
    '\n[[routes]]\npattern = "nikkecollection.com"\ncustom_domain = true',
    '\n[[services]]\nbinding = "STATS"',
    '\n[[d1_databases]]\nbinding = "DB"',
    '\n[[migrations]]\ntag = "v1"',
  ])("bootstrap and publish cannot attach domains or provision backends: %s", (extra) => {
    expect(() => siteDeploymentArguments(sha, config + extra)).toThrow("domain-free");
  });

  it("uses a pinned, protected, serialized dispatch workflow with credentials only at deployment", () => {
    const workflow = readFileSync(".github/workflows/site-worker-promote.yml", "utf8");
    expect(validateWorkflowSource(workflow)).toEqual([]);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/\n {2}(push|pull_request|workflow_run|schedule):/);
    expect(workflow).toContain("group: cloudflare-site-production\n  cancel-in-progress: false");
    expect(workflow).toContain("name: cloudflare-site-production");
    const steps = workflow.split(/ {6}- name: /);
    const credentialSteps = steps.filter((step) => step.includes("secrets."));
    expect(credentialSteps).toHaveLength(1);
    expect(credentialSteps[0]).toContain("Deploy only the production site Worker");
    expect(credentialSteps[0]).toContain("secrets.CLOUDFLARE_SITE_API_TOKEN");
    for (const step of steps.filter((value) => /^(Build exact|Verify production)/.test(value))) {
      expect(step).toContain(`GITHUB_SHA: \${{ needs.preflight.outputs.deploy_sha }}`);
      expect(step).not.toMatch(/CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)/);
    }
    const upload = workflow.indexOf("name: Upload verified candidate artifact");
    for (const gate of ["check:site-production", "smoke:site-production", "check:bundle-budget"]) {
      expect(workflow.indexOf(`npm run ${gate}`)).toBeLessThan(upload);
    }
    expect(workflow).toContain("if: inputs.mode == 'publish'");
    expect(workflow).toContain("node scripts/site-production-deployment.ts verify");
    expect(workflow).not.toMatch(/wrangler (?:d1|rollback)|custom_domain|--routes/);
  });
});
