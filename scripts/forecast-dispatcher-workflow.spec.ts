import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const proposal = readFileSync(".github/workflows/forecast-proposal.yml", "utf8");
const stagingDeploy = readFileSync(".github/workflows/forecast-collector-deploy.yml", "utf8");
const productionPromote = readFileSync(".github/workflows/forecast-collector-promote.yml", "utf8");
const d1BudgetWatch = readFileSync(".github/workflows/forecast-d1-budget-watch.yml", "utf8");
const d1IndexRemediation = readFileSync(
  ".github/workflows/forecast-d1-index-remediation.yml",
  "utf8",
);
const dispatcherConfig = readFileSync("forecast-dispatcher/wrangler.toml", "utf8");
const interactionConfig = readFileSync("forecast-interactions/wrangler.toml", "utf8");
const manualReview = readFileSync(".github/workflows/resolve-forecast-manual-review.yml", "utf8");
const githubApp = readFileSync("forecast-dispatcher/src/github-app.ts", "utf8");
const naverAction = readFileSync("scripts/forecast-naver-action.ts", "utf8");

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
      expect(workflow).toContain("forecast-collector/migrations/0009_d1_budget_canary_v6.sql");
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
    expect(stagingDeploy).toContain("Observe 30-minute account-wide D1 burn-in");
    expect(stagingDeploy).toContain("npm run check:d1-budget -- preflight");
    expect(stagingDeploy.indexOf("Apply staging D1 budget and canary v6 migration")).toBeLessThan(
      stagingDeploy.indexOf("npm run check:d1-budget -- preflight"),
    );
    expect(stagingDeploy).toContain("Verify production and staging Forecast covering indexes");
    expect(stagingDeploy).toContain("--var COLLECT_ENABLED:false");
    expect(stagingDeploy).toContain("--var COLLECT_ENABLED:true");
    expect(stagingDeploy).toContain("npm run check:d1-budget -- evaluate");
    expect(productionPromote).toContain("npm run check:d1-budget -- monitor");
    expect(productionPromote).toContain("npm run check:d1-budget -- preflight");
    expect(d1BudgetWatch).toContain('cron: "7,37 * * * *"');
    expect(d1BudgetWatch).toContain("Disable staging Collector and Dispatcher on budget pressure");
    expect(d1BudgetWatch).toContain("--var COLLECT_ENABLED:false");
    expect(d1IndexRemediation).toContain("environment: cloudflare-production");
    expect(d1IndexRemediation).toContain("Verify statistics production D1 remains readable");
    expect(d1IndexRemediation).toContain(
      "forecast-collector/migrations/0009_d1_budget_canary_v6.sql",
    );
    expect(d1IndexRemediation).toContain("EXPLAIN QUERY PLAN");
    expect(d1IndexRemediation).not.toContain("wrangler deploy");
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

  it("keeps directly executed Node imports resolvable on Linux", () => {
    expect(githubApp).toContain('from "../../shared/boundedHttp.ts"');
    expect(naverAction).toContain('from "../shared/boundedHttp.ts"');
    expect(readFileSync("scripts/cloudflare-d1-budget.ts", "utf8")).toContain(
      'from "./lib/d1-budget.ts"',
    );
    expect(readFileSync("scripts/check-forecast-canary.ts", "utf8")).toContain(
      'from "../shared/d1QuotaEvidence.ts"',
    );
  });
});
