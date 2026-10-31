import { expect, it, vi } from "vitest";
import * as model from "../../../../shared/certifiedSupplyModel";
import * as snapshots from "../../../../shared/supplyForecastBuild";
import * as profiles from "../../../../shared/supplyForecastCandidate";
import * as candidateBuilder from "../../candidate";
import * as admission from "../../candidate-persistence";
import type { CollectorEnv } from "../../types";
import { localDatabase } from "../rules/sqlite-test-db";
import { now, seed } from "./fixture";
import { runV2CandidateUnit } from "./index";

// User-approved local threshold for this unit only (plan §7B): 80 ms.
// Production uses a 300 ms runaway guard and a separate 100 ms performance target.
it("builds one candidate within 80ms thread CPU", async () => {
  const { db, sqlite } = localDatabase();
  try {
    await seed(db);
    const stages: Record<string, number> = {};
    const build = candidateBuilder.buildForecastCandidate;
    const admit = admission.processSourceQueue;
    const snapshot = snapshots.buildScheduleForecastSnapshot;
    const profile = profiles.buildSupplyForecastCandidate;
    const freeze = model.freezeJson;
    const measure = <T>(name: string, operation: () => T) => {
      const before = process.threadCpuUsage();
      const wall = performance.now();
      try {
        return operation();
      } finally {
        const elapsed = process.threadCpuUsage(before);
        stages[name] = (stages[name] ?? 0) + (elapsed.user + elapsed.system) / 1000;
        stages[`${name}Wall`] = (stages[`${name}Wall`] ?? 0) + performance.now() - wall;
      }
    };
    vi.spyOn(snapshots, "buildScheduleForecastSnapshot").mockImplementation((...args) =>
      measure("snapshotMs", () => snapshot(...args)),
    );
    vi.spyOn(profiles, "buildSupplyForecastCandidate").mockImplementation((...args) =>
      measure("profilesMs", () => profile(...args)),
    );
    vi.spyOn(model, "freezeJson").mockImplementation(
      <T>(value: T): T => measure("freezeMs", () => freeze(value)),
    );
    vi.spyOn(candidateBuilder, "buildForecastCandidate").mockImplementation(async (...args) => {
      const before = process.threadCpuUsage();
      const result = await build(...args);
      const elapsed = process.threadCpuUsage(before);
      stages["buildMs"] = (elapsed.user + elapsed.system) / 1000;
      return result;
    });
    vi.spyOn(admission, "processSourceQueue").mockImplementation(async (...args) => {
      const before = process.threadCpuUsage();
      const result = await admit(...args);
      const elapsed = process.threadCpuUsage(before);
      stages["admissionMs"] = (elapsed.user + elapsed.system) / 1000;
      return result;
    });
    const start = process.threadCpuUsage();
    const result = await runV2CandidateUnit(
      { FORECAST_DB: db, FORECAST_V2_MODE: "on" } as CollectorEnv,
      now,
    );
    const cpu = process.threadCpuUsage(start);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    console.log({ cpuMs, stages });
    expect(result).toEqual({ outcome: "built" });
    expect(cpuMs).toBeLessThanOrEqual(80);
  } finally {
    sqlite.close();
    vi.restoreAllMocks();
  }
});
