import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { listCloudflareD1Databases } from "../shared/cloudflareD1Catalog";
import {
  type D1UsageSnapshot,
  evaluateD1CanaryBudget,
  evaluateD1PreflightBudget,
  evaluateD1RuntimeBudget,
  fetchD1UsageSnapshot,
  nearestRankP95,
} from "../shared/cloudflarePaidUsage";
import {
  assertD1QuotaEvidence,
  D1_DATABASE_IDS,
  quotaActionForPercent,
} from "../shared/d1QuotaEvidence";

const BASELINE_AT = Date.parse("2026-09-01T02:00:00.000Z");
const CURRENT_AT = BASELINE_AT + 30 * 60_000;

describe("Cloudflare Paid monthly quota budget", () => {
  it("loads the quota module through the native Node TypeScript ESM loader", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", "await import('./shared/cloudflarePaidUsage.ts')"],
        { cwd: process.cwd(), stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  it.each([
    [24.999999, "normal"],
    [25, "warning"],
    [34.999999, "warning"],
    [35, "disable_staging"],
    [39.999999, "disable_staging"],
    [40, "disable_forecast_production"],
    [44.999999, "disable_forecast_production"],
    [45, "disable_statistics_writes"],
    [49.999999, "disable_statistics_writes"],
    [50, "hard_stop"],
  ] as const)("maps %s%% to %s", (percent, action) => {
    expect(quotaActionForPercent(percent)).toBe(action);
  });

  it("uses nearest-rank p95 and keeps a low-volume monthly projection normal", () => {
    expect(nearestRankP95([1, 2, 3, 4, 5, 6, 7])).toBe(7);
    const evaluation = evaluateD1CanaryBudget(
      snapshot(BASELINE_AT),
      snapshot(CURRENT_AT, { requestDelta: 100, readDelta: 1_000, writeDelta: 10 }),
    );

    expect(evaluation).toMatchObject({ passed: true, action: "normal", reasons: [] });
    expect(evaluation.evidence).toMatchObject({
      version: 2,
      plan: { id: "workers-paid", frequency: "monthly" },
      passed: true,
    });
    expect(evaluation.metrics.projectedPercent).toBeLessThan(25);
  });

  it("selects the strictest action independently across current and projected metrics", () => {
    const warning = evaluateD1PreflightBudget(snapshot(BASELINE_AT, { rowsRead: 6_300_000_000 }));
    const hardStop = evaluateD1PreflightBudget(snapshot(BASELINE_AT, { rowsRead: 12_600_000_000 }));

    expect(warning.action).toBe("hard_stop");
    expect(warning.metrics.currentPercent).toBeGreaterThanOrEqual(25);
    expect(hardStop.action).toBe("hard_stop");
    expect(hardStop.metrics.currentPercent).toBeGreaterThanOrEqual(50);
  });

  it("fails closed before a 30-minute burn-in and across billing periods", () => {
    const tooSoon = snapshot(BASELINE_AT + 29 * 60_000);
    expect(evaluateD1CanaryBudget(snapshot(BASELINE_AT), tooSoon)).toMatchObject({
      passed: false,
      action: "hard_stop",
      reasons: ["cloudflare_paid_burn_in_too_short"],
    });

    const nextPeriod = snapshot(CURRENT_AT, {
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
    });
    expect(() => evaluateD1CanaryBudget(snapshot(BASELINE_AT), nextPeriod)).toThrow(
      "cloudflare_paid_billing_period_changed",
    );
  });

  it("uses a recent runtime delta and rejects counter regression", () => {
    const baseline = snapshot(BASELINE_AT);
    const burnIn = snapshot(CURRENT_AT, { requestDelta: 100, readDelta: 1_000, writeDelta: 10 });
    const evidence = evaluateD1CanaryBudget(baseline, burnIn).evidence;
    if (!evidence) throw new Error("missing_paid_quota_fixture_evidence");

    const runtime = snapshot(CURRENT_AT + 30 * 60_000, {
      requestDelta: 200,
      readDelta: 2_000,
      writeDelta: 20,
    });
    expect(evaluateD1RuntimeBudget(evidence, runtime).evidence?.observedAt).toBe(
      runtime.capturedAt,
    );

    const regressed = snapshot(CURRENT_AT + 30 * 60_000, {
      requestDelta: -1,
      readDelta: -1,
      writeDelta: -1,
    });
    expect(() => evaluateD1RuntimeBudget(evidence, regressed)).toThrow(
      "cloudflare_paid_counter_regression",
    );
  });

  it("rejects detailed evidence that does not match its account-wide totals", () => {
    const evidence = evaluateD1PreflightBudget(snapshot(BASELINE_AT)).evidence;
    if (!evidence) throw new Error("missing_paid_quota_fixture_evidence");
    const mismatched = structuredClone(evidence);
    const firstDatabase = mismatched.databases[0];
    if (!firstDatabase) throw new Error("missing_paid_quota_fixture_database");
    firstDatabase.rowsReadObserved += 1;

    expect(() => assertD1QuotaEvidence(mismatched)).toThrow(
      "cloudflare_paid_quota_d1_reads_mismatch",
    );
  });

  it("rejects duplicate or missing identities in detailed evidence", () => {
    const evidence = evaluateD1PreflightBudget(snapshot(BASELINE_AT)).evidence;
    if (!evidence) throw new Error("missing_paid_quota_fixture_evidence");
    const duplicate = structuredClone(evidence);
    const firstDatabase = duplicate.databases[0];
    const secondDatabase = duplicate.databases[1];
    if (!firstDatabase || !secondDatabase) throw new Error("missing_paid_quota_fixture_database");
    secondDatabase.databaseId = firstDatabase.databaseId;
    expect(() => assertD1QuotaEvidence(duplicate)).toThrow(
      "cloudflare_paid_quota_duplicate_database",
    );

    const missing = structuredClone(evidence);
    missing.databases = missing.databases.filter(
      (database) => database.databaseId !== D1_DATABASE_IDS.usageGuard,
    );
    missing.databases.push({
      databaseId: "0".repeat(36),
      databaseName: "unrelated-replacement",
      rowsReadObserved: 0,
      rowsWrittenObserved: 0,
      storageBytesObserved: 0,
    });
    expect(() => assertD1QuotaEvidence(missing)).toThrow(
      `cloudflare_paid_quota_required_database_missing:${D1_DATABASE_IDS.usageGuard}`,
    );
  });
});

describe("Cloudflare Paid account API", () => {
  it("follows the real D1 count/page/per_page/total_count pagination contract", async () => {
    const databases = Array.from({ length: 101 }, (_, index) => ({
      uuid: `database-${index}`,
      name: `database-${index}`,
    }));
    let requests = 0;
    const fetchImpl: typeof fetch = async (input) => {
      requests += 1;
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      const result = databases.slice((page - 1) * 100, page * 100);
      return Response.json({
        success: true,
        result,
        result_info: {
          count: result.length,
          page,
          per_page: 100,
          total_count: databases.length,
        },
      });
    };

    const catalog = await listCloudflareD1Databases(fetchImpl, "account", "token");
    expect(requests).toBe(2);
    expect(catalog.size).toBe(databases.length);
    expect(catalog.get("database-100")).toBe("database-100");
  });

  it("fails closed when D1 pagination metadata could omit a returned database", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({
        success: true,
        result: [{ uuid: "database-1", name: "database-1" }],
        result_info: { count: 0, page: 1, per_page: 100, total_count: 0 },
      });

    await expect(listCloudflareD1Databases(fetchImpl, "account", "token")).rejects.toThrow(
      "cloudflare_d1_list_pagination_inconsistent",
    );
  });

  it("verifies the Paid subscription and includes unknown account databases and workers", async () => {
    const known = [
      [D1_DATABASE_IDS.statsProduction, "collection-kit-stats"],
      [D1_DATABASE_IDS.statsStaging, "collection-kit-stats-staging"],
      [D1_DATABASE_IDS.forecastProduction, "collection-kit-forecast-collector"],
      [D1_DATABASE_IDS.forecastStaging, "collection-kit-forecast-collector-staging"],
      [D1_DATABASE_IDS.usageGuard, "collection-kit-usage-guard"],
      ["f".repeat(36), "unrelated-database"],
    ] as const;
    let graphqlVariables: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/subscriptions")) {
        return Response.json({
          success: true,
          result: [
            {
              id: "subscription-1",
              state: "Paid",
              frequency: "monthly",
              current_period_start: "2026-08-15T00:00:00Z",
              current_period_end: "2026-09-15T00:00:00Z",
              rate_plan: { id: "workers-paid", public_name: "Workers Paid" },
            },
          ],
        });
      }
      if (url.includes("/d1/database")) {
        return Response.json({
          success: true,
          result: known.map(([uuid, name]) => ({ uuid, name })),
          result_info: {
            count: known.length,
            page: 1,
            per_page: 100,
            total_count: known.length,
          },
        });
      }
      if (url.endsWith("/graphql")) {
        graphqlVariables = JSON.parse(String(init?.body))?.variables as Record<string, unknown>;
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  d1AnalyticsAdaptiveGroups: known.map(([databaseId]) => ({
                    dimensions: { date: "2026-09-01", databaseId },
                    sum: { rowsRead: 10, rowsWritten: 1 },
                  })),
                  d1StorageAdaptiveGroups: known.map(([databaseId]) => ({
                    dimensions: { databaseId },
                    max: { databaseSizeBytes: 1_024 },
                  })),
                  workersInvocationsAdaptive: [
                    {
                      dimensions: {
                        date: "2026-09-01",
                        scriptName: "collection-kit-stats",
                        status: "success",
                      },
                      sum: { requests: 20, errors: 0, cpuTimeUs: 20_000 },
                      quantiles: { cpuTimeP95: 1_500, cpuTimeP99: 2_000 },
                    },
                    {
                      dimensions: {
                        date: "2026-09-01",
                        scriptName: "unrelated-worker",
                        status: "success",
                      },
                      sum: { requests: 5, errors: 0, cpuTimeUs: 5_000 },
                      quantiles: { cpuTimeP95: 750, cpuTimeP99: 1_000 },
                    },
                  ],
                  workerRuntime: [
                    {
                      dimensions: {
                        date: "2026-09-01",
                        scriptName: "collection-kit-stats",
                        status: "success",
                      },
                      sum: { requests: 20, errors: 0, cpuTimeUs: 20_000 },
                      quantiles: { cpuTimeP95: 1_500, cpuTimeP99: 2_000 },
                    },
                  ],
                },
              ],
            },
          },
        });
      }
      return new Response(null, { status: 404 });
    };

    const runtimeStartedAt = new Date(BASELINE_AT - 2 * 60 * 60 * 1_000).toISOString();
    const runtimeEndedAt = new Date(BASELINE_AT - 60 * 60 * 1_000).toISOString();
    const result = await fetchD1UsageSnapshot({
      accountId: "a".repeat(32),
      analyticsToken: "analytics-token",
      billingToken: "billing-token",
      nowMs: BASELINE_AT,
      runtimeStartedAt,
      runtimeEndedAt,
      fetchImpl,
    });

    expect(result.plan).toMatchObject({ id: "workers-paid", verified: true });
    expect(result.databases).toHaveLength(6);
    expect(
      result.databases.find((database) => database.databaseName === "unrelated-database"),
    ).toMatchObject({ rowsReadObserved: 10, rowsWrittenObserved: 1 });
    expect(result.workers.map((worker) => worker.scriptName)).toContain("unrelated-worker");
    expect(result.workerRuntime).toMatchObject({
      startedAt: runtimeStartedAt,
      endedAt: runtimeEndedAt,
      workers: [
        {
          scriptName: "collection-kit-stats",
          cpuTimeAverageMs: 1,
          cpuTimeP95Ms: 1.5,
          cpuTimeP99Ms: 2,
        },
      ],
    });
    expect(graphqlVariables).toMatchObject({
      runtimeStartTimestamp: runtimeStartedAt,
      runtimeEndTimestamp: runtimeEndedAt,
    });
    expect(evaluateD1PreflightBudget(result).evidence?.workerRuntime).toMatchObject({
      startedAt: runtimeStartedAt,
      endedAt: runtimeEndedAt,
    });
  });
});

describe("Cloudflare Paid runtime window API", () => {
  it("requires custom runtime window bounds as a pair before making API requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      fetchD1UsageSnapshot({
        accountId: "a".repeat(32),
        analyticsToken: "analytics-token",
        billingToken: "billing-token",
        nowMs: BASELINE_AT,
        runtimeStartedAt: new Date(BASELINE_AT - 60_000).toISOString(),
        fetchImpl,
      }),
    ).rejects.toThrow("cloudflare_paid_runtime_window_pair_required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Cloudflare Paid subscription validation", () => {
  it("rejects a missing or ambiguous Workers Paid subscription", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/subscriptions")) {
        return Response.json({ success: true, result: [] });
      }
      return new Response(null, { status: 500 });
    };
    await expect(
      fetchD1UsageSnapshot({
        accountId: "a".repeat(32),
        analyticsToken: "analytics-token",
        billingToken: "billing-token",
        nowMs: BASELINE_AT,
        fetchImpl,
      }),
    ).rejects.toThrow("cloudflare_workers_paid_subscription_count:0");
  });

  it("fails closed when Billing Read is forbidden", async () => {
    await expect(
      fetchD1UsageSnapshot({
        accountId: "a".repeat(32),
        analyticsToken: "analytics-token",
        billingToken: "billing-token",
        nowMs: BASELINE_AT,
        fetchImpl: async () => new Response(null, { status: 403 }),
      }),
    ).rejects.toThrow("cloudflare_subscription_http_403");
  });

  it("rejects an expired Workers Paid billing period", async () => {
    await expect(
      fetchD1UsageSnapshot({
        accountId: "a".repeat(32),
        analyticsToken: "analytics-token",
        billingToken: "billing-token",
        nowMs: BASELINE_AT,
        fetchImpl: paidApiFetch({
          current_period_start: "2026-07-31T00:00:00Z",
          current_period_end: "2026-08-31T00:00:00Z",
        }),
      }),
    ).rejects.toThrow("cloudflare_workers_paid_period_invalid");
  });

  it.each([
    ["Workers Free", { id: "workers-free", public_name: "Workers Free" }],
    ["Workers AI Paid", { id: "workers-ai-paid", public_name: "Workers AI Paid" }],
    [
      "Workers Enterprise with a Paid base set",
      { id: "workers-enterprise", public_name: "Workers Enterprise", sets: ["WORKERS_PAID"] },
    ],
    [
      "reseller plan with a Paid display name",
      { id: "workers-reseller", public_name: "Workers Paid", sets: ["WORKERS_PAID"] },
    ],
  ])("rejects the %s plan", async (_label, ratePlan) => {
    await expect(
      fetchD1UsageSnapshot({
        accountId: "a".repeat(32),
        analyticsToken: "analytics-token",
        billingToken: "billing-token",
        nowMs: BASELINE_AT,
        fetchImpl: paidApiFetch({
          rate_plan: ratePlan,
        }),
      }),
    ).rejects.toThrow("cloudflare_workers_paid_subscription_count:0");
  });

  it.each([
    ["28-day", "2026-08-15T00:00:00Z", "2026-09-12T00:00:00Z"],
    ["31-day", "2026-08-15T00:00:00Z", "2026-09-15T00:00:00Z"],
  ])("accepts a current %s billing period", async (_label, periodStart, periodEnd) => {
    const result = await fetchD1UsageSnapshot({
      accountId: "a".repeat(32),
      analyticsToken: "analytics-token",
      billingToken: "billing-token",
      nowMs: BASELINE_AT,
      fetchImpl: paidApiFetch({
        current_period_start: periodStart,
        current_period_end: periodEnd,
      }),
    });

    expect(result.plan).toMatchObject({
      periodStart: new Date(periodStart).toISOString(),
      periodEnd: new Date(periodEnd).toISOString(),
    });
  });
});

describe("Cloudflare Paid GraphQL completeness", () => {
  it("fails closed instead of accepting a partial D1 database listing", async () => {
    const fallback = paidApiFetch();
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes("/d1/database")) {
        return Response.json({
          success: true,
          result: Array.from({ length: 100 }, (_, index) => ({
            uuid: `database-${index}`,
            name: `database-${index}`,
          })),
          result_info: { count: 100, page: 1, per_page: 100, total_count: 5_001 },
        });
      }
      return fallback(input, init);
    };

    await expect(
      fetchD1UsageSnapshot({
        accountId: "a".repeat(32),
        analyticsToken: "analytics-token",
        billingToken: "billing-token",
        nowMs: BASELINE_AT,
        fetchImpl,
      }),
    ).rejects.toThrow("cloudflare_d1_list_page_limit_reached");
  });

  it("fails closed when an analytics group reaches the query limit", async () => {
    const knownDatabases = Object.values(D1_DATABASE_IDS).map((uuid) => ({ uuid, name: uuid }));
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/subscriptions")) {
        return Response.json({
          success: true,
          result: [
            {
              id: "subscription-1",
              state: "Paid",
              frequency: "monthly",
              current_period_start: "2026-08-15T00:00:00Z",
              current_period_end: "2026-09-15T00:00:00Z",
              rate_plan: { id: "workers-paid", public_name: "Workers Paid" },
            },
          ],
        });
      }
      if (url.includes("/d1/database")) {
        return Response.json({
          success: true,
          result: knownDatabases,
          result_info: {
            count: knownDatabases.length,
            page: 1,
            per_page: 100,
            total_count: knownDatabases.length,
          },
        });
      }
      if (url.endsWith("/graphql")) {
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  d1AnalyticsAdaptiveGroups: [],
                  d1StorageAdaptiveGroups: [],
                  workersInvocationsAdaptive: Array.from({ length: 10_000 }, () => ({})),
                  workerRuntime: [],
                },
              ],
            },
          },
        });
      }
      return new Response(null, { status: 404 });
    };

    await expect(
      fetchD1UsageSnapshot({
        accountId: "a".repeat(32),
        analyticsToken: "analytics-token",
        billingToken: "billing-token",
        nowMs: BASELINE_AT,
        fetchImpl,
      }),
    ).rejects.toThrow("cloudflare_paid_graphql_worker_groups_limit_reached");
  });

  it("fails closed when the rolling Worker runtime group reaches the query limit", async () => {
    const knownDatabases = Object.values(D1_DATABASE_IDS).map((uuid) => ({ uuid, name: uuid }));
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/subscriptions")) {
        return Response.json({
          success: true,
          result: [
            {
              id: "subscription-1",
              state: "Paid",
              frequency: "monthly",
              current_period_start: "2026-08-15T00:00:00Z",
              current_period_end: "2026-09-15T00:00:00Z",
              rate_plan: { id: "workers-paid", public_name: "Workers Paid" },
            },
          ],
        });
      }
      if (url.includes("/d1/database")) {
        return Response.json({
          success: true,
          result: knownDatabases,
          result_info: {
            count: knownDatabases.length,
            page: 1,
            per_page: 100,
            total_count: knownDatabases.length,
          },
        });
      }
      if (url.endsWith("/graphql")) {
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  d1AnalyticsAdaptiveGroups: [],
                  d1StorageAdaptiveGroups: [],
                  workersInvocationsAdaptive: [],
                  workerRuntime: Array.from({ length: 10_000 }, () => ({})),
                },
              ],
            },
          },
        });
      }
      return new Response(null, { status: 404 });
    };

    await expect(
      fetchD1UsageSnapshot({
        accountId: "a".repeat(32),
        analyticsToken: "analytics-token",
        billingToken: "billing-token",
        nowMs: BASELINE_AT,
        fetchImpl,
      }),
    ).rejects.toThrow("cloudflare_paid_graphql_worker_runtime_groups_limit_reached");
  });
});

function snapshot(
  capturedAt: number,
  input: {
    rowsRead?: number;
    requestDelta?: number;
    readDelta?: number;
    writeDelta?: number;
    periodStart?: string;
    periodEnd?: string;
  } = {},
): D1UsageSnapshot {
  const requestDelta = input.requestDelta ?? 0;
  const readDelta = input.readDelta ?? 0;
  const writeDelta = input.writeDelta ?? 0;
  const databases = Object.entries(D1_DATABASE_IDS).map(([role, databaseId], index) => ({
    databaseId,
    databaseName: role,
    rowsReadObserved: index === 0 ? (input.rowsRead ?? 10_000) + readDelta : 1_000 + readDelta,
    rowsWrittenObserved: 100 + writeDelta,
    storageBytesObserved: 1_000_000,
  }));
  return {
    version: 2,
    source: "cloudflare-paid-account-analytics-v2",
    accountId: "a".repeat(32),
    capturedAt: new Date(capturedAt).toISOString(),
    plan: {
      id: "workers-paid",
      verified: true,
      state: "Paid",
      frequency: "monthly",
      periodStart: input.periodStart ?? "2026-08-15T00:00:00.000Z",
      periodEnd: input.periodEnd ?? "2026-09-15T00:00:00.000Z",
      subscriptionId: "subscription-1",
      ratePlanId: "workers-paid",
    },
    daily: [
      {
        date: new Date(capturedAt).toISOString().slice(0, 10),
        workerRequests: 1_000 + requestDelta,
        workerCpuMs: 5_000 + requestDelta,
        d1RowsRead: databases.reduce((sum, database) => sum + database.rowsReadObserved, 0),
        d1RowsWritten: databases.reduce((sum, database) => sum + database.rowsWrittenObserved, 0),
      },
    ],
    databases,
    workers: [
      {
        scriptName: "collection-kit-stats",
        requestsObserved: 1_000 + requestDelta,
        cpuMsObserved: 5_000 + requestDelta,
        errorsObserved: 0,
        exceededCpuObserved: 0,
        cpuTimeAverageMs: (5_000 + requestDelta) / (1_000 + requestDelta),
        cpuTimeP95Ms: 1.5,
        cpuTimeP99Ms: 2,
      },
    ],
    workerRuntime: {
      startedAt: new Date(
        Math.max(
          Date.parse(input.periodStart ?? "2026-08-15T00:00:00.000Z"),
          capturedAt - 8 * 60 * 60 * 1_000,
        ),
      ).toISOString(),
      endedAt: new Date(capturedAt).toISOString(),
      workers: [
        {
          scriptName: "collection-kit-stats",
          requestsObserved: 1_000 + requestDelta,
          cpuMsObserved: 5_000 + requestDelta,
          errorsObserved: 0,
          exceededCpuObserved: 0,
          cpuTimeAverageMs: (5_000 + requestDelta) / (1_000 + requestDelta),
          cpuTimeP95Ms: 1.5,
          cpuTimeP99Ms: 2,
        },
      ],
    },
  };
}

function paidApiFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  const databases = Object.values(D1_DATABASE_IDS).map((uuid) => ({ uuid, name: uuid }));
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/subscriptions")) {
      return Response.json({
        success: true,
        result: [
          {
            id: "subscription-1",
            state: "Paid",
            frequency: "monthly",
            current_period_start: "2026-08-15T00:00:00Z",
            current_period_end: "2026-09-15T00:00:00Z",
            rate_plan: { id: "workers-paid", public_name: "Workers Paid" },
            ...overrides,
          },
        ],
      });
    }
    if (url.includes("/d1/database")) {
      return Response.json({
        success: true,
        result: databases,
        result_info: {
          count: databases.length,
          page: 1,
          per_page: 100,
          total_count: databases.length,
        },
      });
    }
    if (url.endsWith("/graphql")) {
      return Response.json({
        data: {
          viewer: {
            accounts: [
              {
                d1AnalyticsAdaptiveGroups: [],
                d1StorageAdaptiveGroups: [],
                workersInvocationsAdaptive: [],
                workerRuntime: [],
              },
            ],
          },
        },
      });
    }
    return new Response(null, { status: 404 });
  };
}
