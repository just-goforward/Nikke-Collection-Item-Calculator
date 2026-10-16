import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const collector = readFileSync(".github/workflows/forecast-collector-deploy.yml", "utf8");
const stats = readFileSync(".github/workflows/worker-deploy.yml", "utf8");
const budget = readFileSync(".github/workflows/forecast-d1-budget-watch.yml", "utf8");

function job(source: string, name: string) {
  const value = source.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
  if (!value) throw new Error(`Missing job: ${name}`);
  return value;
}

function jobCondition(source: string, name: string) {
  const match = job(source, name).match(/^ {4}if: (?:>-\n((?: {6}.+\n)+)|(.+)\n)/m);
  if (!match) throw new Error(`Missing job condition: ${name}`);
  return (match[1] ?? match[2] ?? "").trim();
}

function step(source: string, name: string) {
  const value = source.split(`      - name: ${name}\n`)[1]?.split("\n      - name: ")[0];
  if (!value) throw new Error(`Missing step: ${name}`);
  return value;
}

function stepCondition(source: string, name: string) {
  const condition = step(source, name).match(/^ {8}if: (.+)$/m)?.[1];
  if (!condition) throw new Error(`Missing step condition: ${name}`);
  return condition;
}

function decision(condition: string, setting: string, context: Record<string, unknown> = {}) {
  return runInNewContext(condition, {
    vars: { FORECAST_STAGING_AUTO_REDEPLOY: setting },
    always: () => true,
    ...context,
  }) as boolean;
}

function github(eventName: string, ref = "refs/heads/main", overrides = {}) {
  return {
    event_name: eventName,
    ref,
    repository: "owner/repo",
    event: {
      workflow_run: {
        conclusion: "success",
        event: "push",
        head_branch: "main",
        head_repository: { full_name: "owner/repo" },
        ...overrides,
      },
    },
  };
}

describe("Staging redeploy maintenance switch", () => {
  it.each(["", "enabled", "disabled"])(
    "gates both deployment jobs without changing trusted triggers (setting=%s)",
    (setting) => {
      const enabled = setting !== "disabled";
      const collectorCondition = jobCondition(collector, "deploy-staging");
      const statsCondition = jobCondition(stats, "staging");
      for (const event of ["push", "workflow_dispatch"]) {
        expect(decision(collectorCondition, setting, { github: github(event) })).toBe(enabled);
        expect(
          decision(collectorCondition, setting, { github: github(event, "refs/heads/next") }),
        ).toBe(false);
      }
      expect(decision(statsCondition, setting, { github: github("workflow_dispatch") })).toBe(
        enabled,
      );
      expect(decision(statsCondition, setting, { github: github("workflow_run") })).toBe(enabled);
      expect(
        decision(statsCondition, setting, {
          github: github("workflow_dispatch", "refs/heads/next", { conclusion: "failure" }),
        }),
      ).toBe(false);
      for (const overrides of [
        { conclusion: "failure" },
        { event: "pull_request" },
        { head_branch: "next" },
        { head_repository: { full_name: "other/repo" } },
      ]) {
        expect(
          decision(statsCondition, setting, {
            github: github("workflow_run", "refs/heads/main", overrides),
          }),
        ).toBe(false);
      }
    },
  );

  it.each(["", "enabled", "disabled"])(
    "suppresses only staging budget redeployment, not production escalation or alerts (setting=%s)",
    (setting) => {
      for (const stop of ["false", "true"]) {
        const context = {
          steps: {
            action: {
              outputs: { stop_staging: stop, emergency_action: "hard_stop", alert: "true" },
            },
          },
        };
        expect(
          decision(
            stepCondition(budget, "Disable staging Collector and Dispatcher on budget pressure"),
            setting,
            context,
          ),
        ).toBe(stop === "true" && setting !== "disabled");
        expect(
          decision(
            stepCondition(budget, "Request protected production Cron stop"),
            setting,
            context,
          ),
        ).toBe(true);
      }
      const unaffected = budget
        .replace(step(budget, "Record staging redeploy suppression"), "")
        .replace(step(budget, "Disable staging Collector and Dispatcher on budget pressure"), "")
        .replace(step(budget, "Send direct Discord runtime budget alert"), "");
      expect(unaffected).not.toContain("FORECAST_STAGING_AUTO_REDEPLOY");
    },
  );

  it.each(["", "enabled", "disabled"])(
    "records a summary notice only when disabled (setting=%s)",
    (setting) => {
      for (const source of [collector, stats, budget]) {
        const condition =
          source === budget
            ? stepCondition(source, "Record staging redeploy suppression")
            : jobCondition(source, "staging-redeploy-disabled");
        expect(decision(condition, setting)).toBe(setting === "disabled");
        expect(step(source, "Record staging redeploy suppression")).toContain(
          "$GITHUB_STEP_SUMMARY",
        );
      }
    },
  );
});

describe("Shared Guard safety during staging maintenance", () => {
  it.each(["", "enabled", "disabled"])(
    "keeps shared Guard verification, schema, secrets, deployment and refresh independent (setting=%s)",
    (setting) => {
      const guard = job(collector, "deploy-usage-guard");
      const staging = job(collector, "deploy-staging");
      for (const event of ["push", "workflow_dispatch"]) {
        expect(
          decision(jobCondition(collector, "deploy-usage-guard"), setting, {
            github: github(event),
          }),
        ).toBe(true);
        expect(
          decision(jobCondition(collector, "deploy-usage-guard"), setting, {
            github: github(event, "refs/heads/next"),
          }),
        ).toBe(false);
      }
      expect(guard).not.toContain("FORECAST_STAGING_AUTO_REDEPLOY");
      expect(guard).not.toMatch(/^ {4}needs:/m);
      expect(guard).not.toContain("--config forecast-collector/wrangler.toml");
      expect(guard).not.toContain("--config forecast-dispatcher/wrangler.toml");
      expect(staging).toContain("- name: Observe 30-minute account-wide D1 burn-in");
      expect(staging).toContain(
        "- name: Fail-closed rollback when staging validation fails - Collector",
      );
      expect(staging).toContain("needs: deploy-usage-guard");
      expect(staging).not.toContain("--config usage-guard/wrangler.toml");
      for (const name of [
        "Verify Paid usage guard",
        "Apply usage guard D1 schema",
        "Prepare usage guard secrets",
        "Deploy and initialize Paid usage guard",
      ]) {
        expect(step(guard, name)).not.toMatch(/^ {8}if:/m);
        expect(staging).not.toContain(`- name: ${name}`);
      }
      expect(step(guard, "Deploy and initialize Paid usage guard")).toContain("/admin/refresh");
      expect(step(guard, "Prepare Guard npm 12.2.0 with pinned integrity")).toContain(
        "run: *prepare_forecast_npm",
      );
    },
  );

  it.each([
    ["disabled", "normal", "skipped"],
    ["disabled", "hard_stop", "skipped"],
    ["disabled", "disable_forecast_production", "skipped"],
    ["disabled", "", "skipped"],
    ["enabled", "normal", "failure"],
    ["", "disable_staging", "success"],
  ])(
    "reports policy and observed effective Guard action without claiming a stop (%s, %s, %s)",
    (setting, effective, outcome) => {
      const alert = step(budget, "Send direct Discord runtime budget alert");
      const context = {
        steps: {
          guard: { outputs: { action: effective } },
          staging_stop: { outcome },
          action: { outputs: { alert: "true" } },
        },
      };
      expect(
        decision(
          stepCondition(budget, "Send direct Discord runtime budget alert"),
          setting,
          context,
        ),
      ).toBe(true);
      const bindingPattern = /^ {10}((?:STAGING_|GUARD_)[A-Z_]+): \$\{\{ (.+) \}\}$/gm;
      const variables = Object.fromEntries(
        [...alert.matchAll(bindingPattern)].map(([, key, expression]) => [
          key,
          runInNewContext(expression ?? "", {
            vars: { FORECAST_STAGING_AUTO_REDEPLOY: setting },
            ...context,
          }),
        ]),
      );
      const template = alert.match(/--arg content "(.+)" \\/)?.[1] ?? "";
      const message = template.replace(/\$([A-Z_]+)/g, (_, key: string) => variables[key]);
      expect(message).toContain(
        `Observed effective Usage Guard action: ${effective || "unavailable"}`,
      );
      expect(message).not.toContain("persisted");
      expect(budget).not.toContain("persisted_action");
      expect(budget).not.toContain("GUARD_PERSISTED_ACTION");
      expect(message).toContain(`Redeploy step outcome: ${outcome}`);
      expect(message).toContain(
        setting === "disabled"
          ? "suppressed (FORECAST_STAGING_AUTO_REDEPLOY=disabled)"
          : "Staging redeploy: enabled",
      );
      expect(message).not.toContain("was stopped");
      expect(step(budget, "Read Paid usage guard health")).toContain(
        "action=$(jq -er '.effectiveAction' \"$RUNNER_TEMP/usage-guard-health.json\")",
      );
    },
  );
});
