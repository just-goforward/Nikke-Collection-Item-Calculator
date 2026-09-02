import { describe, expect, it } from "vitest";
import { D1_DATABASE_IDS } from "../shared/d1QuotaEvidence";
import {
  type D1UsageDatabase,
  type D1UsageSnapshot,
  evaluateD1CanaryBudget,
  evaluateD1PreflightBudget,
  evaluateD1RuntimeBudget,
  fetchD1UsageSnapshot,
  nearestRankP95,
} from "./lib/d1-budget";

const BASELINE_AT = Date.parse("2026-09-01T02:00:00.000Z");
const CURRENT_AT = BASELINE_AT + 30 * 60_000;

describe("D1 canary budget", () => {
  it("uses nearest-rank p95 and passes a bounded four-database burn-in", () => {
    expect(nearestRankP95([1, 2, 3, 4, 5, 6, 7])).toBe(7);
    const baseline = snapshot(BASELINE_AT, {
      productionReads: 1_000,
      productionWrites: 10,
      canaryReads: 2_000,
      canaryWrites: 20,
    });
    const current = snapshot(CURRENT_AT, {
      productionReads: 1_500,
      productionWrites: 15,
      canaryReads: 3_000,
      canaryWrites: 30,
    });

    const evaluation = evaluateD1CanaryBudget(baseline, current);

    expect(evaluation).toMatchObject({ passed: true, reasons: [] });
    expect(evaluation.evidence?.canary).toMatchObject({
      rowsReadBurnIn: 1_000,
      rowsWrittenBurnIn: 10,
      rowsReadProjected: 32_000,
      rowsWrittenProjected: 320,
    });
    expect(evaluation.evidence?.statsProduction).toMatchObject({
      rowsReadReserve: 1_000_000,
      rowsWrittenReserve: 30_000,
    });
    expect(
      evaluation.evidence?.databases.find(
        (database) => database.databaseId === D1_DATABASE_IDS.forecastProduction,
      ),
    ).toMatchObject({ rowsReadProjected: 17_000, rowsWrittenProjected: 170 });
  });

  it("uses bounded Forecast allowances after covering indexes instead of stale p95 scans", () => {
    const historicalFullScans = snapshot(BASELINE_AT, {
      canaryReads: 2_000,
      canaryWrites: 20,
      productionHistoryReads: 12_000_000,
      canaryHistoryReads: 16_000_000,
    });

    const evaluation = evaluateD1PreflightBudget(historicalFullScans);

    expect(evaluation).toMatchObject({ passed: true, reasons: [] });
    expect(evaluation.metrics?.accountRowsReadProjected).toBeLessThan(3_000_000);
  });

  it("fails preflight after index verification when observed usage plus allowances is unsafe", () => {
    const unsafe = snapshot(BASELINE_AT, { canaryReads: 2_900_000, canaryWrites: 59_000 });

    const evaluation = evaluateD1PreflightBudget(unsafe);

    expect(evaluation.passed).toBe(false);
    expect(evaluation.reasons).toContain("d1_budget_projected_reads_exceeded");
    expect(evaluation.reasons).toContain("d1_budget_projected_writes_exceeded");
  });

  it("fails closed when the staging burn-in projects beyond its read allowance", () => {
    const baseline = snapshot(BASELINE_AT, { canaryReads: 2_000, canaryWrites: 20 });
    const current = snapshot(CURRENT_AT, { canaryReads: 12_000, canaryWrites: 30 });

    const evaluation = evaluateD1CanaryBudget(baseline, current);

    expect(evaluation.passed).toBe(false);
    expect(evaluation.reasons).toContain("d1_budget_canary_reads_exceeded");
    expect(evaluation.evidence).toBeNull();
  });

  it("includes production Forecast growth in the runtime account projection", () => {
    const baseline = snapshot(BASELINE_AT, { canaryReads: 2_000, canaryWrites: 20 });
    const burnIn = snapshot(CURRENT_AT, {
      productionReads: 1_500,
      productionWrites: 15,
      canaryReads: 3_000,
      canaryWrites: 30,
    });
    const initial = evaluateD1CanaryBudget(baseline, burnIn).evidence;
    if (!initial) throw new Error("Expected the burn-in fixture to produce quota evidence.");
    const runtime = snapshot(CURRENT_AT + 30 * 60_000, {
      productionReads: 101_500,
      productionWrites: 25,
      canaryReads: 4_000,
      canaryWrites: 40,
    });

    const evaluation = evaluateD1RuntimeBudget(initial, runtime);

    expect(evaluation.passed).toBe(false);
    expect(evaluation.reasons).toContain("d1_budget_projected_reads_exceeded");
  });

  it("rejects a burn-in that crosses the UTC D1 billing boundary", () => {
    const baseline = snapshot(Date.parse("2026-09-01T23:45:00.000Z"), {
      canaryReads: 2_000,
      canaryWrites: 20,
    });
    const current = snapshot(Date.parse("2026-09-02T00:15:00.000Z"), {
      canaryReads: 3_000,
      canaryWrites: 30,
    });

    expect(() => evaluateD1CanaryBudget(baseline, current)).toThrow(
      "d1_budget_billing_day_changed",
    );
  });

  it("includes unknown account databases instead of silently omitting their usage", async () => {
    const known = [
      [D1_DATABASE_IDS.statsProduction, "collection-kit-stats"],
      [D1_DATABASE_IDS.statsStaging, "collection-kit-stats-staging"],
      [D1_DATABASE_IDS.forecastProduction, "collection-kit-forecast-collector"],
      [D1_DATABASE_IDS.forecastStaging, "collection-kit-forecast-collector-staging"],
      ["f".repeat(36), "unrelated-database"],
    ];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/d1/database")) {
        return Response.json({
          success: true,
          result: known.map(([uuid, name]) => ({ uuid, name })),
          result_info: { total_pages: 1 },
        });
      }
      if (url.endsWith("/graphql")) {
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  d1AnalyticsAdaptiveGroups: known.map(([databaseId]) => ({
                    dimensions: { date: "2026-09-01", databaseId },
                    sum: { rowsRead: 10, rowsWritten: 1 },
                  })),
                },
              ],
            },
          },
        });
      }
      return new Response(null, { status: 404 });
    };

    const result = await fetchD1UsageSnapshot({
      accountId: "a".repeat(32),
      token: "redacted-test-token",
      nowMs: Date.parse("2026-09-01T02:00:00.000Z"),
      fetchImpl,
    });

    expect(result.databases).toHaveLength(5);
    expect(
      result.databases.find((database) => database.databaseName === "unrelated-database"),
    ).toMatchObject({ role: "other", daily: [{ rowsRead: 10, rowsWritten: 1 }] });
  });
});

function snapshot(
  capturedAt: number,
  input: {
    canaryReads: number;
    canaryWrites: number;
    productionReads?: number;
    productionWrites?: number;
    productionHistoryReads?: number;
    productionHistoryWrites?: number;
    canaryHistoryReads?: number;
    canaryHistoryWrites?: number;
  },
): D1UsageSnapshot {
  const billingDay = new Date(capturedAt).toISOString().slice(0, 10);
  return {
    version: 1,
    source: "cloudflare-graphql-d1-analytics-v1",
    accountId: "a".repeat(32),
    capturedAt: new Date(capturedAt).toISOString(),
    billingDay,
    databases: [
      database(D1_DATABASE_IDS.statsProduction, "collection-kit-stats", "stats-production", {
        billingDay,
        todayReads: 10_000,
        todayWrites: 100,
        historyReads: 100_000,
        historyWrites: 1_000,
      }),
      database(D1_DATABASE_IDS.statsStaging, "collection-kit-stats-staging", "stats-staging", {
        billingDay,
        todayReads: 100,
        todayWrites: 1,
        historyReads: 100,
        historyWrites: 1,
      }),
      database(
        D1_DATABASE_IDS.forecastProduction,
        "collection-kit-forecast-collector",
        "forecast-production",
        {
          billingDay,
          todayReads: input.productionReads ?? 1_000,
          todayWrites: input.productionWrites ?? 10,
          historyReads: input.productionHistoryReads ?? 1_000,
          historyWrites: input.productionHistoryWrites ?? 10,
        },
      ),
      database(
        D1_DATABASE_IDS.forecastStaging,
        "collection-kit-forecast-collector-staging",
        "forecast-staging",
        {
          billingDay,
          todayReads: input.canaryReads,
          todayWrites: input.canaryWrites,
          historyReads: input.canaryHistoryReads ?? 2_000,
          historyWrites: input.canaryHistoryWrites ?? 20,
        },
      ),
    ],
  };
}

function database(
  databaseId: string,
  databaseName: string,
  role: D1UsageDatabase["role"],
  input: {
    billingDay: string;
    todayReads: number;
    todayWrites: number;
    historyReads: number;
    historyWrites: number;
  },
): D1UsageDatabase {
  const current = Date.parse(`${input.billingDay}T00:00:00.000Z`);
  return {
    databaseId,
    databaseName,
    role,
    daily: [
      ...Array.from({ length: 7 }, (_, index) => ({
        date: new Date(current - (7 - index) * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10),
        rowsRead: input.historyReads,
        rowsWritten: input.historyWrites,
      })),
      {
        date: input.billingDay,
        rowsRead: input.todayReads,
        rowsWritten: input.todayWrites,
      },
    ],
  };
}
