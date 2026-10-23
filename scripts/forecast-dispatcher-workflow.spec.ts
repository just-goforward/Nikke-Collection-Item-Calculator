import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const staging = readFileSync(".github/workflows/forecast-collector-deploy.yml", "utf8");
const budgetWatch = readFileSync(".github/workflows/forecast-d1-budget-watch.yml", "utf8");

function step(name: string) {
  const value = staging.split(`      - name: ${name}\n`)[1]?.split("\n      - name: ")[0];
  if (!value) throw new Error(`missing_workflow_step:${name}`);
  return value;
}

function recoveryDecision(source: string, verified: string, attempted: string, cancelled = false) {
  const condition = source.match(/^ {8}if: (.+)$/m)?.[1];
  if (!condition) throw new Error("missing_recovery_condition");
  const activation = { outputs: { attempted } };
  return runInNewContext(condition, {
    always: () => true,
    failure: () => !cancelled,
    cancelled: () => cancelled,
    steps: {
      operational_verification: { outputs: { verified } },
      collector_activation: activation,
      dispatcher_activation: activation,
    },
  });
}

describe("staging-only forecast deployment", () => {
  it("cannot recreate production forecast Workers", () => {
    expect(existsSync(".github/workflows/forecast-collector-promote.yml")).toBe(false);
    expect(existsSync(".github/workflows/forecast-router-bootstrap.yml")).toBe(false);
    expect(existsSync(".github/workflows/forecast-d1-index-remediation.yml")).toBe(false);
    const commands = staging
      .split("\n")
      .filter((line) =>
        /wrangler deploy .*--config forecast-(collector|dispatcher|interactions)\//.test(line),
      );
    expect(commands.length).toBeGreaterThan(5);
    for (const command of commands) expect(command).toContain("--env staging");
    expect(staging).not.toContain('--env="" --config forecast-');
    expect(staging).not.toContain("FORECAST_INTERACTIONS_URL");
    expect(staging).not.toContain("Require the production-owned Router");
  });

  it("retains trusted-main, maintenance opt-out and explicit activation gates", () => {
    expect(staging).toContain("github.ref == 'refs/heads/main'");
    expect(staging).toContain("vars.FORECAST_STAGING_AUTO_REDEPLOY == 'disabled'");
    expect(staging).toContain("vars.FORECAST_STAGING_AUTO_REDEPLOY != 'disabled'");
    expect(staging).toContain("router_endpoint_ready:");
    expect(staging).toContain("default: false");
    for (const name of [
      "Activate staging collector for live contract probe",
      "Activate staging dispatcher after collector readiness",
      "Live staging dispatcher outbox readiness",
      "Start fixed eight-hour v2 canary",
      "Align canary start using version-bound scheduled telemetry",
    ])
      expect(step(name)).toContain(
        "github.event_name == 'workflow_dispatch' && inputs.router_endpoint_ready",
      );
    expect(step("Deploy staging collector")).toContain("--var COLLECT_ENABLED:false");
    expect(step("Deploy staging dispatcher")).toContain("--var DISPATCH_ENABLED:false");
    expect(step("Deploy staging dispatcher")).toContain(
      "--var FORECAST_V2_NOTIFICATIONS_ENABLED:false",
    );
    expect(step("Deploy staging collector")).toContain("--var FORECAST_V2_MODE:on");
    expect(step("Activate staging collector for live contract probe")).toContain(
      "--var FORECAST_V2_MODE:on",
    );
    // The Collector no longer serves Discord interactions; the Router owns them.
    expect(step("Deploy staging collector")).not.toContain("DISCORD_INTERACTION_OWNER");
    expect(step("Deploy staging collector")).not.toContain("DISCORD_CHANNEL_ID");
  });

  it("keeps migrations and verification ahead of staging deployment", () => {
    const migration = step("Apply staging Forecast D1 migrations");
    expect(migration).toContain("--env staging --remote --allow-forecast-v2");
    expect(staging.indexOf("Apply staging Forecast D1 migrations")).toBeLessThan(
      staging.indexOf("      - name: Deploy staging collector"),
    );
    for (const test of [
      "apply-forecast-d1-migrations.v2-gate.spec.ts",
      "apply-forecast-d1-migrations.fail-closed.spec.ts",
      "forecast-migration-0030.spec.ts",
    ])
      expect(step("Verify Forecast migration runner")).toContain(test);
    for (const component of ["collector", "dispatcher"])
      expect(step(`Verify ${component}`)).toContain(`npm run test:forecast-${component}`);
    expect(step("Verify interaction Router")).toContain(
      "wrangler deploy --dry-run --env staging --config forecast-interactions/wrangler.toml",
    );
    expect(step("Verify staging Forecast covering indexes")).toContain("--remote --env staging");
  });

  it("validates the staging Router origin before mutations and verifies its exact identity", () => {
    const validation = step("Validate required Router origin after dependency installation");
    expect(validation).toContain('--router-origin "$FORECAST_INTERACTIONS_STAGING_URL"');
    expect(staging.indexOf("Install dependencies")).toBeLessThan(
      staging.indexOf("Validate required Router origin after dependency installation"),
    );
    expect(
      staging.indexOf("Validate required Router origin after dependency installation"),
    ).toBeLessThan(staging.indexOf("Apply staging Forecast D1 migrations"));
    const readiness = step("Verify staging interactions readiness");
    expect(readiness).toContain(
      'smoke:forecast-interactions -- "$FORECAST_INTERACTIONS_STAGING_URL"',
    );
    expect(readiness).toContain("--env staging --config forecast-interactions/wrangler.toml");
    expect(readiness).toContain('.vars.FORECAST_ENVIRONMENT == "staging"');
    expect(readiness).toContain(".productionMutationsEnabled == false");
    expect(step("Deploy staging interactions")).toContain(
      "--var PRODUCTION_MUTATIONS_ENABLED:false",
    );
    expect(step("Deploy staging interactions")).toContain("--var PRODUCTION_PUBLICATION_MODE:off");
  });

  it("uses only bounded read probes for dispatcher outboxes", () => {
    const smoke = step("Live staging dispatcher outbox readiness");
    expect(smoke).toContain("d1 execute FORECAST_DB --remote --env staging");
    expect(smoke).toContain("forecast_runtime_outbox WHERE environment='staging' LIMIT 1");
    expect(smoke).toContain("forecast_v2_notification_outbox LIMIT 1");
    expect(smoke).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/);
    expect(smoke).not.toContain("FORECAST_COLLECTOR_ADMIN_TOKEN");
    expect(step("Check dispatcher outbox inside the canary window")).toContain(
      "run: *staging_outbox_readiness",
    );
    expect(staging).not.toContain("recover-forecast-boundary");
    expect(staging).not.toContain("recovery_source");
    expect(staging).not.toContain("dispatcher callback and Discord smoke");
  });

  it("preserves quota, statistics-isolation and live Observability gates", () => {
    for (const name of [
      "Verify statistics production D1 remains readable",
      "Check account-wide D1 preflight after index verification",
      "Verify account Cron trigger capacity",
      "Verify Paid account-wide baseline",
      "Verify live Workers Observability contract before burn-in",
      "Observe 30-minute account-wide D1 burn-in",
      "Recheck Workers Observability contract after burn-in",
      "Evaluate account-wide D1 budget",
      "Refresh Paid usage guard after burn-in",
    ])
      expect(step(name)).not.toContain("continue-on-error");
    expect(step("Observe 30-minute account-wide D1 burn-in")).toContain("sleep 1800");
    expect(step("Fail after D1 budget rollback")).toContain("run: exit 1");
    const alignment = step("Align canary start using version-bound scheduled telemetry");
    expect(alignment).toContain("scripts/check-forecast-canary-start.ts");
    expect(alignment).toContain("npm run preflight:forecast-runtime");
    expect(alignment).not.toContain(".collector.lastFinishedAt");
    expect(alignment).not.toContain(".operations.dispatcher.lastObservedAt");
  });

  it.each(["Collector", "Dispatcher"])(
    "stops an activated %s on failure/cancellation, not after completed verification",
    (component) => {
      const recovery = step(`Fail-closed rollback when staging validation fails - ${component}`);
      expect(recoveryDecision(recovery, "true", "true")).toBe(false);
      expect(recoveryDecision(recovery, "", "true")).toBe(true);
      expect(recoveryDecision(recovery, "", "true", true)).toBe(true);
      expect(recoveryDecision(recovery, "", "")).toBe(false);
      expect(recovery).toContain("--env staging");
      expect(recovery).toContain(
        component === "Collector" ? "--var COLLECT_ENABLED:false" : "--var DISPATCH_ENABLED:false",
      );
      expect(recovery).toContain("--active-version");
      expect(recovery).not.toContain("continue-on-error");
    },
  );
});

describe("staging forecast evidence retention", () => {
  it("retains only explicitly projected rollout evidence", () => {
    const allowed = new Set([
      "collector-active-identity.evidence.json",
      "dispatcher-active-identity.evidence.json",
      "staging-router-identity.evidence.json",
      "staging-router-health.evidence.json",
      "*-active-identity.evidence.json",
      "*-validation-stop-identity.evidence.json",
      "canary-start-identity.evidence.json",
      "forecast-observability-live-probe.evidence.json",
      "forecast-observability-preflight.evidence.json",
      "forecast-canary-start-runtime.evidence.json",
      "d1-budget-preflight.evidence.json",
      "d1-budget-baseline.evidence.json",
      "d1-budget-evaluation.evidence.json",
    ]);
    const blocks = [...staging.matchAll(/^ {10}path: \|\n((?: {12}.+\n)+)/gm)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks)
      for (const path of (block[1] ?? "").trim().split("\n"))
        expect(allowed.has(path.trim().replace("${{ runner.temp }}/", "")), path).toBe(true);
  });

  it("keeps the account-wide budget watcher because it can stop staging", () => {
    expect(budgetWatch).toContain("watch-staging:");
    expect(budgetWatch).toContain("Disable staging Collector and Dispatcher on budget pressure");
    expect(budgetWatch).toContain("vars.FORECAST_STAGING_AUTO_REDEPLOY != 'disabled'");
  });

  it("uses only staging Discord credentials for the routing smoke", () => {
    const routing = readFileSync(".github/workflows/discord-forecast-routing-smoke.yml", "utf8");
    expect(routing).toContain("secrets.DISCORD_FORECAST_STAGING_BOT_TOKEN");
    for (const role of ["APPROVAL", "ACTIVITY", "ALERT"])
      expect(routing).toContain(`vars.DISCORD_FORECAST_STAGING_${role}_CHANNEL_ID`);
    expect(routing).toContain("FORECAST_ENVIRONMENT: staging");
    expect(routing).not.toContain("secrets.DISCORD_FORECAST_BOT_TOKEN");
  });

  it("needs no project dependencies before npm ci", () => {
    const beforeInstall = staging.slice(0, staging.indexOf("      - name: Install dependencies"));
    expect([...beforeInstall.matchAll(/^\s*(?:run: )?node (scripts\/\S+\.ts)([^\n]*)$/gm)]).toEqual(
      [],
    );
  });
});
