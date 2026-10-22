import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { validateWorkflowSource } from "./check-workflow-hardening";

const source = (file: string) => readFileSync(`.github/workflows/${file}`, "utf8");
const promotion = source("worker-promote.yml");
const rollback = source("worker-rollback.yml");
const pages = source("pages.yml");
const site = source("site-worker-promote.yml");
const observer = source("stats-observer-promote.yml");
const staging = source("worker-deploy.yml");

function guards(workflow: string) {
  return [...workflow.matchAll(/node --input-type=module <<'NODE'\r?\n([\s\S]*?)\r?\n *NODE/g)]
    .map((match) => (match[1] ?? "").replace(/^ +/gm, ""))
    .filter((body) => body.includes("Candidate probe capability differs"));
}

// Execute the actual trusted-YAML policy with in-memory Git/file adapters. No Git or network.
function evaluateGuard(
  body: string,
  file: string,
  changes: Record<string, string | undefined> = {},
  changedCandidate = false,
) {
  const sha = "a".repeat(40);
  const env = {
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `owner/repo/.github/workflows/${file}@refs/heads/main`,
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_WORKFLOW_SHA: sha,
    SITE_DEPLOY_MODE: "publish",
    PRODUCTION_SMOKE_PROFILE: "gateway",
    PRODUCTION_WORKER_URL: "https://nikkecollection.com",
    ...changes,
  };
  const execFileSync = vi.fn((command: string, args: string[]) => {
    expect(command).toBe("git");
    expect(args[0]).toBe("show");
    expect(args[1]?.startsWith(`${sha}:`)).toBe(true);
    return Buffer.from(`trusted:${args[1]?.slice(sha.length + 1)}`);
  });
  runInNewContext(body.replace(/^import .*;\r?\n/gm, ""), {
    process: { env },
    createHash,
    readFileSync: (path: string) =>
      Buffer.from(changedCandidate ? "old adapter" : `trusted:${path}`),
    execFileSync,
  });
  return execFileSync;
}

describe("trusted main-ref adapter gates", () => {
  it.each([
    ["worker-promote.yml", promotion],
    ["site-worker-promote.yml", site],
    ["stats-observer-promote.yml", observer],
  ])("checks the candidate independently before and after approval in %s", (file, workflow) => {
    const policies = guards(workflow);
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      expect(evaluateGuard(policy, file).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(() => evaluateGuard(policy, file, {}, true)).toThrow("Candidate probe capability");
      expect(() => evaluateGuard(policy, file, { GITHUB_REF: "refs/heads/untrusted" })).toThrow();
      expect(() => evaluateGuard(policy, file, { GITHUB_WORKFLOW_SHA: "" })).toThrow();
    }
    const production =
      workflow.split(file === "site-worker-promote.yml" ? "\n  deploy:" : "\n  production:")[1] ??
      "";
    expect(guards(production)).toHaveLength(1);
    expect(production.indexOf("Candidate probe capability")).toBeLessThan(
      production.indexOf("npm ci"),
    );
    expect(production).toContain("fetch-depth: 0");
  });

  it("rejects bootstrap and mismatched production profiles without candidate execution", () => {
    for (const policy of guards(site)) {
      expect(() =>
        evaluateGuard(policy, "site-worker-promote.yml", {
          SITE_DEPLOY_MODE: "bootstrap",
        }),
      ).toThrow("publish-only");
    }
    for (const policy of guards(promotion)) {
      for (const change of [
        { PRODUCTION_SMOKE_PROFILE: undefined },
        { PRODUCTION_SMOKE_PROFILE: "direct" },
        { PRODUCTION_WORKER_URL: "https://collection-kit-stats-staging.tbvj159.workers.dev" },
      ])
        expect(() => evaluateGuard(policy, "worker-promote.yml", change)).toThrow("profile");
      expect(() =>
        evaluateGuard(policy, "worker-promote.yml", {
          PRODUCTION_SMOKE_PROFILE: "direct",
          PRODUCTION_WORKER_URL: "https://collection-kit-stats.tbvj159.workers.dev",
        }),
      ).not.toThrow();
    }
  });
});

describe("stats contract workflow wiring and budgets", () => {
  it("keeps both staging callers explicitly staging-only and free of probe credentials", () => {
    for (const workflow of [staging, source("stats-observer-deploy.yml")]) {
      expect(workflow).toContain(
        'smoke:stats-worker -- "$STAGING_WORKER_URL" "$STATS_ALLOWED_ORIGIN" full direct-staging',
      );
      expect(workflow).not.toContain("STATS_HEALTH_PROBE_TOKEN");
    }
  });

  it("rejects a production or non-exact staging URL before staging probes or mutations", () => {
    for (const workflow of [staging, source("stats-observer-deploy.yml")]) {
      const guard = workflow.match(/node -e '([^']*Staging probe origin mismatch[^']*)'/)?.[1];
      if (!guard) throw new Error("Missing trusted staging-origin gate");
      const evaluate = (url: string) =>
        runInNewContext(guard, {
          process: { env: { STAGING_WORKER_URL: url } },
        });
      expect(() =>
        evaluate("https://collection-kit-stats-staging.tbvj159.workers.dev"),
      ).not.toThrow();
      for (const url of [
        "https://collection-kit-stats.tbvj159.workers.dev",
        "https://collection-kit-stats-staging.tbvj159.workers.dev/",
        "",
      ])
        expect(() => evaluate(url)).toThrow("Staging probe origin mismatch");
      expect(workflow.indexOf(guard)).toBeLessThan(workflow.indexOf("npm run check:d1-schema"));
      expect(workflow.indexOf(guard)).toBeLessThan(workflow.indexOf("npm run smoke:stats-worker"));
    }
  });

  it("isolates Pages credentials in a main-only protected, bounded publication prerequisite", () => {
    const verify = pages.split("\n  verify:")[1]?.split("\n  production-contract:")[0] ?? "";
    const contract = pages.split("\n  production-contract:")[1]?.split("\n  deploy:")[0] ?? "";
    const deploy = pages.split("\n  deploy:")[1]?.split("\n  post-deploy-smoke:")[0] ?? "";
    expect(verify).not.toContain("STATS_HEALTH_PROBE_TOKEN");
    expect(contract).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(contract).toContain("name: cloudflare-stats-probe");
    expect(contract).toContain("timeout-minutes: 15");
    expect(contract).toContain("needs: verify");
    expect(contract.indexOf("npm ci --ignore-scripts")).toBeLessThan(
      contract.indexOf("secrets.STATS_HEALTH_PROBE_TOKEN"),
    );
    expect(deploy).toContain("needs:\n      - verify\n      - production-contract");
    expect(contract).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  it("requires profiles, confines credentials to probe steps and preserves restore verification", () => {
    for (const workflow of [promotion, rollback, pages, observer]) {
      expect(workflow).toContain("vars.CLOUDFLARE_PRODUCTION_SMOKE_PROFILE");
      expect(workflow).toContain("== 'gateway' && secrets.STATS_HEALTH_PROBE_TOKEN || ''");
      expect(workflow).not.toContain("CLOUDFLARE_PRODUCTION_SMOKE_PROFILE ||");
      for (const step of workflow.split("\n      - ")) {
        if (step.includes("secrets.STATS_HEALTH_PROBE_TOKEN")) {
          expect(step).toContain("smoke:stats-worker");
          expect(step).not.toContain("npm ci");
        }
      }
    }
    for (const workflow of [promotion, rollback]) {
      expect(workflow).toContain('readiness-only "$PRODUCTION_SMOKE_PROFILE"');
      expect(workflow).toContain("Verify authenticated transport before");
      expect(workflow.match(/full "\$PRODUCTION_SMOKE_PROFILE"/g)).toHaveLength(2);
      expect(workflow).toContain("Verify restored production contract");
      expect(workflow).toContain("transport failure is not proof of backend incompatibility");
      expect(workflow).toContain("outputs.verification_class");
      expect(workflow).toContain('if [[ "$VERIFICATION_CLASS" == "transport" ]]');
      expect(workflow).toContain("verification unavailable (transport); precautionary restore");
    }
    expect(promotion.indexOf('readiness-only "$PRODUCTION_SMOKE_PROFILE"')).toBeLessThan(
      promotion.indexOf("- name: Ensure production D1 schema"),
    );
    expect(rollback.indexOf('readiness-only "$PRODUCTION_SMOKE_PROFILE"')).toBeLessThan(
      rollback.indexOf("- name: Roll back production Worker"),
    );
    expect(observer.split("\n  production:")[0]).not.toContain("STATS_HEALTH_PROBE_TOKEN");
  });

  it("bounds four probe slots, with Stats promotion and rollback sharing one", () => {
    expect(promotion).toContain("group: cloudflare-worker-production");
    expect(rollback).toContain("group: cloudflare-worker-production");
    expect(site).toContain("group: cloudflare-site-production");
    expect(observer).toContain("group: stats-observer-production");
    expect(pages).toContain("group: cloudflare-stats-probe-pages");
    for (const workflow of [promotion, rollback, site, observer]) {
      expect(workflow).toContain("cancel-in-progress: false");
    }
  });

  it("passes the workflow hardening policy for every touched workflow", () => {
    for (const workflow of [
      promotion,
      rollback,
      pages,
      site,
      observer,
      staging,
      source("stats-observer-deploy.yml"),
    ]) {
      expect(validateWorkflowSource(workflow)).toEqual([]);
    }
  });
});
