import { afterEach, describe, expect, it, vi } from "vitest";

import { STAGING_RUNTIME_SEARCH } from "../../shared/runtimeEnvironment";
import {
  prepareRuntimeSupplyForecast,
  resolveRuntimeSupplyForecast,
} from "../lib/supplyForecastRuntime";
import { solve } from "../solver/solve";
import { installSupplyForecastFixtureClock } from "../solver/supplyForecast.test-helper";
import {
  makeRuntimeInvariantEvent,
  makeSolverDiagnosticEvent,
  makeSolverRecoveryEvent,
} from "./calculatorDiagnostics";
import { clampStock, readCache, rememberCache, type SolverResult } from "./calculatorShared";
import { queueOutcomeDiagnostics } from "./calculatorSolveFlow";

installSupplyForecastFixtureClock();
afterEach(() => vi.unstubAllGlobals());

describe("makeSolverDiagnosticEvent", () => {
  it("uses the solved forecast after coverage expires and isolates optional telemetry failures", async () => {
    vi.stubGlobal("location", new URL(`https://example.test/${STAGING_RUNTIME_SEARCH}`));
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    await prepareRuntimeSupplyForecast(STAGING_RUNTIME_SEARCH);
    const result = solve({
      start: { grade: "SR", level: 14, exp: 2900 },
      stock: { blue: 19, purple: 0, yellow: 0 },
      strategy: "supply",
    }) as SolverResult;
    const captured = result.stats?.supplyForecast;
    if (!captured) throw new Error("solved_forecast_fixture_missing");
    vi.setSystemTime(new Date("2026-12-11T00:00:00Z"));
    const outcome = {
      result,
      executionKind: "executed" as const,
      requestedBackend: "js-phase2" as const,
    };
    expect(makeSolverDiagnosticEvent(outcome, "en")).toMatchObject({
      forecastId: captured.forecastId,
      forecastProfileId: captured.forecastProfileId,
    });
    const delivery = vi.fn(() => {
      throw new Error("telemetry_unavailable");
    });
    expect(
      queueOutcomeDiagnostics({ calculationLocale: "en", queueStatsEvent: delivery }, outcome),
    ).toBe(false);
    expect(delivery).toHaveBeenCalledOnce();
    const { supplyForecast: _captured, ...oldStats } = result.stats ?? {};
    expect(
      makeSolverDiagnosticEvent({ ...outcome, result: { ...result, stats: oldStats } }, "en"),
    ).toBeNull();
    expect(result.possible).toBe(true);
  });

  it("creates a low-cardinality runtime invariant event", () => {
    expect(makeRuntimeInvariantEvent("worker_idle_pending", "worker_client", "validation")).toEqual(
      {
        kind: "runtime_invariant",
        invariantVersion: 1,
        code: "worker_idle_pending",
        component: "worker_client",
        lane: "validation",
      },
    );
  });

  it("uses solver version and phase from result stats", () => {
    const forecast = resolveRuntimeSupplyForecast();
    const result: SolverResult = {
      possible: true,
      input: {
        start: { grade: "SR", level: 10, exp: 0 },
        stock: { blue: 100, purple: 100, yellow: 100 },
      },
      best: {
        firstAction: "yellow",
        firstProbability: 0.45,
        run: {
          count: 1,
          success: { grade: "SR", level: 15, exp: 0 },
          fail: { grade: "SR", level: 11, exp: 0 },
        },
        vector: { blue: 0, purple: 0, yellow: 10 },
        totalKits: 10,
        successProbability: 0.5,
        maxSuccessProbability: 0.5,
        probabilityGap: 0,
        resourceCost: 0.1,
        legacySupplyCost: 0.2,
      },
      candidateCount: 1,
      stats: {
        solverVersion: "phase2_availability_h075_tau0_p3_rust_rerank_staging",
        solverPhase: "phase2-rerank",
        solverBackend: "rust-phase2-rerank",
        fallbackFrom: "rust-min-ef",
        fallbackReason: "memo_full",
        memoryStrategy: "balanced-v1",
        minEfMemoTier: 21,
        phase2MemoTier: 22,
        phase2MemoRetried: false,
        attemptedStates: 750_000,
        states: 12_000,
        solveMs: 123,
      },
      topCandidates: [],
    };

    expect(
      makeSolverDiagnosticEvent(
        {
          executionKind: "executed",
          requestedBackend: "rust-min-ef",
          result,
        },
        "ja",
      ),
    ).toMatchObject({
      diagnosticVersion: 8,
      forecastId: forecast.forecastId,
      forecastProfileId: forecast.profile.id,
      locale: "ja",
      executionKind: "executed",
      requestedBackend: "rust-min-ef",
      solverVersion: "phase2_availability_h075_tau0_p3_rust_rerank_staging",
      solverPhase: "phase2-rerank",
      solverBackend: "rust-phase2-rerank",
      fallbackFrom: "rust-min-ef",
      fallbackReason: "memo_full",
      memoryStrategy: "balanced-v1",
      minEfMemoTier: "21",
      phase2MemoTier: "22",
      phase2MemoRetried: "no",
      nodeCountBucket: "10000_99999",
      attemptedNodeCountBucket: "500000_999999",
      solveMsBucket: "100_250",
      stockBuckets: { blue: "100_149", purple: "100_149", yellow: "100_149" },
    });
  });

  it("refreshes cache recency on reads", () => {
    const cache = new Map<string, number>();
    rememberCache(cache, "a", 1, 2);
    rememberCache(cache, "b", 2, 2);

    expect(readCache(cache, "a")).toBe(1);
    rememberCache(cache, "c", 3, 2);

    expect([...cache.entries()]).toEqual([
      ["a", 1],
      ["c", 3],
    ]);
  });

  it("clamps stock to the shared product input range", () => {
    expect(
      clampStock({
        blue: -1,
        purple: 100_000,
        yellow: 100_001,
      }),
    ).toEqual({
      blue: 0,
      purple: 100_000,
      yellow: 100_000,
    });
  });

  it("emits only bucketed recovery context when the backend changes", () => {
    expect(
      makeSolverRecoveryEvent(
        {
          start: { grade: "R", level: 0, exp: 0 },
          stock: { blue: 400, purple: 200, yellow: 100 },
          strategy: "supply",
        },
        {
          jsExit: "not_attempted",
          minEfExit: "memo_full",
          phase2Exit: "success",
          policyVersion: "ladder_v2",
          requestedBackend: "rust-min-ef",
          terminalBackend: "rust-phase2",
          terminalOutcome: "success",
        },
      ),
    ).toMatchObject({
      kind: "solver_recovery",
      minEfExit: "memo_full",
      phase2Exit: "success",
      stockBuckets: { blue: "400_449", purple: "200_249", yellow: "100_149" },
      terminalBackend: "rust-phase2",
    });
  });
});
