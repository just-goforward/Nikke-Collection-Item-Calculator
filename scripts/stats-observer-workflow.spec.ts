import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deploy = readFileSync(".github/workflows/stats-observer-deploy.yml", "utf8");
const canary = readFileSync(".github/workflows/stats-observer-canary.yml", "utf8");
const promote = readFileSync(".github/workflows/stats-observer-promote.yml", "utf8");
const audit = readFileSync(".github/workflows/audit-solver-recovery-history.yml", "utf8");
const statsDeploy = readFileSync(".github/workflows/worker-deploy.yml", "utf8");
const statsPromote = readFileSync(".github/workflows/worker-promote.yml", "utf8");
const observerConfig = readFileSync("stats-observer/wrangler.toml", "utf8");
const recoveryContract = readFileSync("shared/solverRecoveryContract.ts", "utf8");

describe("Stats Observer workflow contract", () => {
  it("keeps the Observer private, bounded, and on the thirty-minute offset Cron", () => {
    expect(observerConfig).toContain("workers_dev = false");
    expect(observerConfig).toContain('crons = ["7,37 * * * *"]');
    expect(observerConfig).toContain("cpu_ms = 25");
    expect(observerConfig).toContain("head_sampling_rate = 0.25");
    expect(observerConfig).not.toContain("routes =");
  });

  it("requires the additive stats migration before either statistics deployment", () => {
    for (const workflow of [statsDeploy, statsPromote]) {
      expect(workflow).toContain("cloudflare/add-solver-observability-v10.sql");
      expect(workflow).toContain("npm run check:d1-schema");
    }
  });

  it("pins staging deployment and the exact eight-hour certificate to one SHA", () => {
    expect(deploy).toContain("Stats Observer staging deploy must target current trusted main");
    expect(deploy).toContain("Statistics Worker and Observer SHA differ");
    expect(canary).toContain("+8*60*60*1000");
    expect(canary).toContain("npm run check:stats-observer-canary");
    expect(canary).toContain("retention-days: 30");
    expect(promote).toContain("Certified staging Observer is no longer active");
  });

  it("keeps production writes and production history reads approval-gated", () => {
    expect(promote).toContain("environment:\n      name: cloudflare-production");
    expect(audit).toContain("environment:\n      name: cloudflare-production");
    expect(audit).toContain("The workflow is read-only");
    expect(audit).toContain("retention-days: 30");
    expect(audit).not.toContain("contents: write");
    expect(audit).not.toContain("pull-requests: write");
  });

  it("leaves the browser on recovery v1 until the server-first rollout is complete", () => {
    expect(recoveryContract).toContain("SOLVER_RECOVERY_EMIT_VERSION: SolverRecoveryVersion = 1");
    expect(recoveryContract).toContain("STATS_DELIVERY_HEALTH_EMIT_ENABLED = false");
    expect(recoveryContract).toContain('"ladder_v1", "ladder_v2"');
  });
});
