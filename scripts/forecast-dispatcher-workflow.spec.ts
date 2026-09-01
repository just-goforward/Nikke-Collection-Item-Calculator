import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const proposal = readFileSync(".github/workflows/forecast-proposal.yml", "utf8");
const stagingDeploy = readFileSync(".github/workflows/forecast-collector-deploy.yml", "utf8");
const productionPromote = readFileSync(".github/workflows/forecast-collector-promote.yml", "utf8");
const dispatcherConfig = readFileSync("forecast-dispatcher/wrangler.toml", "utf8");
const interactionConfig = readFileSync("forecast-interactions/wrangler.toml", "utf8");
const manualReview = readFileSync(".github/workflows/resolve-forecast-manual-review.yml", "utf8");

describe("Forecast dispatcher workflow contract", () => {
  it("keeps the proposal schedule as a thirty-minute watchdog", () => {
    expect(proposal).toContain('cron: "17,47 * * * *"');
    expect(proposal).not.toContain('cron: "*/5 * * * *"');
    expect(proposal).toContain("dispatch_id:");
    expect(proposal).toContain("dispatch_mode:");
    expect(proposal).toContain("/admin/workflow-dispatches/$FORECAST_DISPATCH_ID/status");
    expect(proposal).toContain("/admin/ops-alerts/watchdog-fallback");
    expect(proposal).toContain("/admin/ops-alerts/watchdog-notification-failed");
    expect(proposal).toContain("/admin/ops-alerts/source-processor-internal");
    expect(proposal).toContain("enforce_nonce:true");
    expect(proposal).toContain("vars.DISCORD_FORECAST_ALERT_CHANNEL_ID");
    expect(proposal).toContain(
      'const tracked=dispatcher !== undefined && dispatcher.status !== "missing";',
    );
    expect(proposal).toContain('stale && unsentCritical ? "both"');
    expect(proposal).toContain('reason === "dispatcher_stale"');
    expect(proposal).not.toContain(
      "const stale=!Number.isFinite(observed) || Date.now()-observed>10*60*1000;",
    );
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
      expect(workflow).toContain(
        "--var DISCORD_ACTIVITY_CHANNEL_ID:$DISCORD_FORECAST_ACTIVITY_CHANNEL_ID",
      );
      expect(workflow).toContain(
        "--var DISCORD_ALERT_CHANNEL_ID:$DISCORD_FORECAST_ALERT_CHANNEL_ID",
      );
      expect(workflow).toContain(
        "--var DISCORD_FALLBACK_CHANNEL_ID:$DISCORD_FORECAST_FALLBACK_CHANNEL_ID",
      );
      expect(workflow).toContain("forecast-collector/migrations/0007_workflow_dispatch_ops.sql");
      expect(workflow).toContain(
        "forecast-collector/migrations/0008_manual_reviews_interactions_canary.sql",
      );
      expect(workflow).toContain("forecast-interactions/wrangler.toml");
    }
    expect(interactionConfig).not.toContain("[triggers]");
    expect(stagingDeploy).toContain("router_endpoint_ready:");
    expect(stagingDeploy).toContain("Start fresh eight-hour canary");
    expect(productionPromote).toContain("Read authenticated eight-hour canary report");
    expect(productionPromote).toContain("environment: cloudflare-production");
    expect(productionPromote).toContain("Determine coupled production rollout");
    expect(stagingDeploy).toContain("Probe GitHub App installation and fixed workflow");
    expect(stagingDeploy).toContain("Disable staging dispatcher after smoke failure");
    for (const workflow of [stagingDeploy, productionPromote]) {
      expect(workflow).toContain("DISCORD_FORECAST_APPLICATION_ID");
      expect(workflow).toContain("DISCORD_FORECAST_PUBLIC_KEY");
      expect(workflow).toContain("does not match the repository variable");
    }
  });

  it("keeps manual review resolution read-only and approval-gated in production", () => {
    expect(manualReview).toContain("permissions:\n  contents: read");
    expect(manualReview).toContain("environment: cloudflare-production");
    expect(manualReview).toContain("npm run resolve:forecast-manual-review");
    expect(manualReview).not.toContain("pull-requests: write");
    expect(manualReview).not.toContain("contents: write");
  });
});
