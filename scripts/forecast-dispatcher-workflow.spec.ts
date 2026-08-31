import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const proposal = readFileSync(".github/workflows/forecast-proposal.yml", "utf8");
const stagingDeploy = readFileSync(".github/workflows/forecast-collector-deploy.yml", "utf8");
const productionPromote = readFileSync(".github/workflows/forecast-collector-promote.yml", "utf8");
const dispatcherConfig = readFileSync("forecast-dispatcher/wrangler.toml", "utf8");

describe("Forecast dispatcher workflow contract", () => {
  it("keeps the proposal schedule as a thirty-minute watchdog", () => {
    expect(proposal).toContain('cron: "17,47 * * * *"');
    expect(proposal).not.toContain('cron: "*/5 * * * *"');
    expect(proposal).toContain("dispatch_id:");
    expect(proposal).toContain("dispatch_mode:");
    expect(proposal).toContain("/admin/workflow-dispatches/$FORECAST_DISPATCH_ID/status");
    expect(proposal).toContain("/admin/ops-alerts/watchdog-fallback");
    expect(proposal).toContain(
      '"$FORECAST_DISPATCH_MODE" == "smoke" && -z "$FORECAST_DISPATCH_ID"',
    );
  });

  it("uses an offset private Worker Cron and a two-phase deployment", () => {
    expect(dispatcherConfig).toContain('crons = ["1-59/3 * * * *"]');
    expect(dispatcherConfig).toContain("workers_dev = false");
    expect(dispatcherConfig).not.toContain("GITHUB_APP_PRIVATE_KEY =");
    for (const workflow of [stagingDeploy, productionPromote]) {
      expect(workflow).toContain("--var DISPATCH_ENABLED:false");
      expect(workflow).toContain("--var DISPATCH_ENABLED:true");
      expect(workflow).toContain("forecast-collector/migrations/0007_workflow_dispatch_ops.sql");
    }
    expect(productionPromote).toContain("environment: cloudflare-production");
    expect(productionPromote).toContain("Determine coupled production rollout");
    expect(stagingDeploy).toContain("Probe GitHub App installation and fixed workflow");
    expect(stagingDeploy).toContain("Disable staging dispatcher after smoke failure");
  });
});
