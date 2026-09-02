import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { D1_DATABASE_IDS } from "../shared/d1QuotaEvidence";

const read = (path: string) => readFileSync(path, "utf8");

describe("Cloudflare Paid quota configuration", () => {
  it.each([
    ["cloudflare/wrangler.toml", 10, 0.1, 2],
    ["forecast-collector/wrangler.toml", 50, 0.25, 2],
    ["forecast-dispatcher/wrangler.toml", 25, 0.25, 2],
    ["forecast-interactions/wrangler.toml", 10, 0.25, 1],
    ["usage-guard/wrangler.toml", 25, 0.25, 1],
  ] as const)("pins CPU and log sampling for %s", (path, cpuMs, sampling, occurrences) => {
    const config = read(path);
    expect([...config.matchAll(/^cpu_ms = (\d+)$/gm)].map((match) => Number(match[1]))).toEqual(
      Array.from({ length: occurrences }, () => cpuMs),
    );
    expect(
      [...config.matchAll(/^head_sampling_rate = ([0-9.]+)$/gm)].map((match) => Number(match[1])),
    ).toEqual(Array.from({ length: occurrences }, () => sampling));
  });

  it("keeps the project Cron allowlist and dedicated guard database fixed", () => {
    expect(read("usage-guard/wrangler.toml")).toContain('crons = ["*/15 * * * *"]');
    expect(read("forecast-collector/wrangler.toml")).toContain('crons = ["*/3 * * * *"]');
    expect(read("forecast-dispatcher/wrangler.toml")).toContain('crons = ["1-59/3 * * * *"]');
    expect(read("cloudflare/wrangler.toml")).toContain('crons = ["17 3 * * *"]');

    for (const path of [
      "cloudflare/wrangler.toml",
      "forecast-collector/wrangler.toml",
      "forecast-dispatcher/wrangler.toml",
      "forecast-interactions/wrangler.toml",
      "usage-guard/wrangler.toml",
    ]) {
      expect(read(path)).toContain(D1_DATABASE_IDS.usageGuard);
    }
  });

  it("keeps the public statistics write path ahead of D1 in the required order", () => {
    const source = read("cloudflare/src/event-submission.ts");
    const rateLimit = source.indexOf("await nativeRateLimit(request, env)");
    const turnstile = source.indexOf("await verifyTurnstile(");
    const quota = source.indexOf('await assertQuotaAllows(env, "statistics_write")');
    const commit = source.indexOf("await commitSubmission(");
    expect(rateLimit).toBeGreaterThan(-1);
    expect(turnstile).toBeGreaterThan(rateLimit);
    expect(quota).toBeGreaterThan(turnstile);
    expect(commit).toBeGreaterThan(quota);
    expect(read("cloudflare/src/rate-limit.ts")).not.toContain("INSERT INTO rate_limits");
  });

  it("requires separate analytics and Billing Read credentials in quota workflows", () => {
    for (const path of [
      ".github/workflows/forecast-collector-deploy.yml",
      ".github/workflows/forecast-collector-promote.yml",
      ".github/workflows/forecast-d1-budget-watch.yml",
      ".github/workflows/worker-deploy.yml",
      ".github/workflows/worker-promote.yml",
    ]) {
      const workflow = read(path);
      expect(workflow).toContain("CLOUDFLARE_D1_ANALYTICS_TOKEN");
      expect(workflow).toContain("CLOUDFLARE_BILLING_READ_TOKEN");
      expect(workflow).toContain("CLOUDFLARE_USAGE_GUARD_URL");
      expect(workflow).not.toContain(
        "secrets.CLOUDFLARE_D1_ANALYTICS_TOKEN || secrets.CLOUDFLARE_API_TOKEN",
      );
    }
  });

  it("uses the fixed eight-hour v7 canary contract", () => {
    const watcher = read(".github/workflows/forecast-d1-budget-watch.yml");
    const deploy = read(".github/workflows/forecast-collector-deploy.yml");
    expect(watcher).toContain("active v7 canary");
    expect(watcher).toContain("report?.version === 7");
    expect(watcher).not.toContain("active v6 canary");
    expect(deploy).toContain("Start fixed eight-hour Paid canary v7");
    expect(deploy).not.toContain("until_d1_reset");
  });

  it("refreshes a separate rolling eight-hour Worker CPU window before final canary evaluation", () => {
    const analytics = read("shared/cloudflarePaidUsage.ts");
    const query = read("shared/cloudflarePaidUsageQuery.ts");
    const promotion = read(".github/workflows/forecast-collector-promote.yml");
    expect(analytics).toContain("const WORKER_RUNTIME_WINDOW_MS = 8 * 60 * 60 * 1_000");
    expect(query).toContain("workerRuntime: workersInvocationsAdaptive(");
    expect(query).toContain("quantiles { cpuTimeP95 cpuTimeP99 }");
    expect(analytics).toContain("runtimeWorkerGroups");
    expect(promotion.indexOf("/admin/refresh")).toBeGreaterThan(-1);
    expect(promotion.indexOf("Read authenticated Paid canary v7 report")).toBeGreaterThan(
      promotion.indexOf("/admin/refresh"),
    );
  });

  it("waits for the deployed Usage Guard SHA before sending the mutating refresh", () => {
    const deploy = read(".github/workflows/forecast-collector-deploy.yml");
    const readiness = deploy.indexOf('"$CLOUDFLARE_USAGE_GUARD_URL/health"');
    const deploymentIdentity = deploy.indexOf("'.deploymentSha == $sha'");
    const refresh = deploy.indexOf('"$CLOUDFLARE_USAGE_GUARD_URL/admin/refresh"');
    expect(readiness).toBeGreaterThan(-1);
    expect(deploymentIdentity).toBeGreaterThan(readiness);
    expect(refresh).toBeGreaterThan(deploymentIdentity);
    expect(deploy).toContain("for attempt in {1..12}");
    expect(deploy).toContain("if (( attempt < 12 )); then sleep 5; fi");
  });

  it("keeps production Cron removal behind approval and preserves the Usage Guard Cron", () => {
    const workflow = read(".github/workflows/cloudflare-quota-emergency-stop.yml");
    const watchdog = read(".github/workflows/forecast-d1-budget-watch.yml");
    expect(workflow).toContain("environment: cloudflare-production");
    expect(workflow).toContain("collection-kit-forecast-collector");
    expect(workflow).toContain("collection-kit-stats");
    expect(workflow).not.toContain("collection-kit-usage-guard\n");
    expect(workflow).toContain("Usage Guard Cron was intentionally retained");
    expect(watchdog).toContain("cloudflare-quota-emergency-stop.yml");
    expect(watchdog).toContain("actions: write");
  });

  it("propagates stale guard escalation to the watchdog before health validation", () => {
    const guard = read("usage-guard/src/worker.ts");
    const watchdog = read(".github/workflows/forecast-d1-budget-watch.yml");
    expect(guard).toContain("effectiveUsageGuardAction(");
    expect(guard).toContain("effectiveAction,");
    expect(watchdog.indexOf("echo \"action=$(jq -er '.effectiveAction'")).toBeLessThan(
      watchdog.indexOf("jq -e '.ok == true"),
    );
    expect(watchdog).toContain(
      'if [[ "$GUARD_OUTCOME" != "success" ]]; then\n            stop_staging=true',
    );
  });
});
