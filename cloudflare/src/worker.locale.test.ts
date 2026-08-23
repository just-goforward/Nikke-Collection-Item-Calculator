import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { solverDiagnosticEvent } from "./worker.test-events";
import { WorkerTestHarness } from "./worker.test-harness";

const harness = new WorkerTestHarness();

beforeEach(async () => {
  await harness.setup();
});

afterEach(async () => {
  await harness.teardown();
});

describe("calculation locale aggregates", () => {
  it("stores the calculation-time locale and exposes it through admin diagnostics", async () => {
    const payload = solverDiagnosticEvent("solver-locale-store-001");
    payload.event.locale = "ja";
    payload.event.requestedBackend = "rust-min-ef";
    payload.event.solverBackend = "rust-phase2";

    expect((await harness.submit(payload)).status).toBe(200);

    const stored = await harness.database
      .prepare(
        `SELECT forecast_id, locale, requested_backend, terminal_backend, execution_kind, events
         FROM calculation_locale_aggregates`,
      )
      .first<{
        forecast_id: string;
        locale: string;
        requested_backend: string;
        terminal_backend: string;
        execution_kind: string;
        events: number;
      }>();
    expect(stored).toEqual({
      forecast_id: "supply-2026-08-21-v1",
      locale: "ja",
      requested_backend: "rust-min-ef",
      terminal_backend: "rust-phase2",
      execution_kind: "executed",
      events: 1,
    });

    const response = await harness.fetchAdminSolverDiagnostics();
    const body = (await response.json()) as {
      calculationLocales?: unknown[];
      localeDataPolicy?: unknown;
    };
    expect(body.calculationLocales).toEqual([
      {
        diagnosticVersion: 7,
        forecastId: "supply-2026-08-21-v1",
        locale: "ja",
        requestedBackend: "rust-min-ef",
        terminalBackend: "rust-phase2",
        executionKind: "executed",
        events: 1,
      },
    ]);
    expect(body.localeDataPolicy).toEqual({
      source: "solver_diagnostic_at_calculation_time",
      missingLocaleEventsExcluded: true,
      supportedLocales: ["ko", "ja", "en"],
    });
  });

  it("keeps executed calculations and cache hits separate for each locale", async () => {
    const executed = solverDiagnosticEvent("solver-locale-exec-0001");
    const cacheHit = solverDiagnosticEvent("solver-locale-cache-001");
    executed.event.locale = "en";
    cacheHit.event.locale = "en";
    cacheHit.event.executionKind = "cache_hit";

    expect((await harness.submit(executed)).status).toBe(200);
    expect((await harness.submit(cacheHit)).status).toBe(200);

    const rows = await harness.database
      .prepare(
        `SELECT locale, execution_kind, SUM(events) AS events
         FROM calculation_locale_aggregates
         GROUP BY locale, execution_kind
         ORDER BY execution_kind`,
      )
      .all<{ locale: string; execution_kind: string; events: number }>();
    expect(rows.results).toEqual([
      { locale: "en", execution_kind: "cache_hit", events: 1 },
      { locale: "en", execution_kind: "executed", events: 1 },
    ]);
  });

  it("accepts older diagnostics without guessing a locale", async () => {
    const legacy = solverDiagnosticEvent("solver-locale-legacy01");
    Reflect.deleteProperty(legacy.event, "locale");

    expect((await harness.submit(legacy)).status).toBe(200);
    await expect(harness.countRows("solver_diagnostic_aggregates")).resolves.toBe(1);
    await expect(harness.countRows("calculation_locale_aggregates")).resolves.toBe(0);
  });
});
