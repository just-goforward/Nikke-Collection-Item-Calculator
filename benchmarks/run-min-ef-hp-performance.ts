import { readFile } from "node:fs/promises";
import { createServer } from "vite";

import {
  assertPhaseLatencyRecordConsistency,
  type CompletedPhaseLatencyRecord,
  nearestRankPercentile,
  summarizePhaseLatencySamples,
} from "./latency-report.ts";
import { readHpStudyReport, writeHpStudyReport } from "./min-ef-hp-report.ts";
import { envValue, parseList, parsePositiveInteger } from "./runner-utils.ts";

const REPORT_FILE = new URL(
  envValue("HP_STUDY_REPORT_FILE") ?? "min-ef-hp-study.json",
  new URL("./results/", import.meta.url),
);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const SCENARIO_IDS = ["SR5-blue30", "R10-balanced300"] as const;
const ABBA = ["A", "B", "B", "A"] as const;
const repeats = parsePositiveInteger(envValue("HP_STUDY_PERF_REPEATS"), 31);
const campaignCount = parsePositiveInteger(envValue("HP_STUDY_PERF_CAMPAIGNS"), 2);

const wasm = await readFile(WASM_URL);
const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false },
});

try {
  const report = await readHpStudyReport(REPORT_FILE);
  if (report?.tailRisk.status !== "completed") {
    throw new Error("Complete held-out tail confirmation before finalist performance measurement.");
  }
  const model = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-model.ts",
  )) as typeof import("./min-ef-hp-model");
  const policy = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-policy.ts",
  )) as typeof import("./min-ef-hp-policy");
  const quality = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-quality.ts",
  )) as typeof import("./min-ef-hp-quality");
  const fixed = (await server.ssrLoadModule(
    "/benchmarks/scenarios/fixed-grid.ts",
  )) as typeof import("./scenarios/fixed-grid");
  const scenarioById = new Map(fixed.FIXED_SAFETY_GRID.map((scenario) => [scenario.id, scenario]));
  const confirmation = readTailConfirmation(report.tailRisk);
  const baselineId = report.baselineVerification.candidateId;
  const defaultCandidateIds = confirmation
    .filter((entry) => entry.passed)
    .map((entry) => entry.candidateId);
  const candidateIds = parseList(envValue("HP_STUDY_CANDIDATES"), defaultCandidateIds);
  const records = report.performance.records as PerformanceRecord[];

  for (const candidateId of candidateIds) {
    if (candidateId === baselineId) continue;
    const candidate = model.hpCandidateById(candidateId);
    const baseline = model.hpCandidateById(baselineId);
    for (const scenarioId of SCENARIO_IDS) {
      const scenario = scenarioById.get(scenarioId);
      if (!scenario) throw new Error(`Missing H/p performance scenario ${scenarioId}.`);
      for (let campaign = 1; campaign <= campaignCount; campaign += 1) {
        if (
          records.some(
            (record) =>
              record.candidateId === candidateId &&
              record.scenarioId === scenarioId &&
              record.campaign === campaign &&
              record.repeats === repeats,
          )
        ) {
          continue;
        }
        const baselineCold: number[] = [];
        const baselineWarm: number[] = [];
        const candidateCold: number[] = [];
        const candidateWarm: number[] = [];
        let failure: string | null = null;
        for (let repeat = 0; repeat < repeats; repeat += 1) {
          const first = ABBA[repeat % ABBA.length] ?? "A";
          const order = first === "A" ? [baseline, candidate] : [candidate, baseline];
          for (const current of order) {
            const measurement = await measurePair(
              wasm,
              current,
              scenario,
              policy.createHpLadderSession,
              report.options.supplyForecast,
            );
            if (measurement.status === "failure") {
              failure = `${current.id}:${measurement.error}`;
              break;
            }
            const cold = current.id === baselineId ? baselineCold : candidateCold;
            const warm = current.id === baselineId ? baselineWarm : candidateWarm;
            cold.push(measurement.coldMs);
            warm.push(measurement.warmMs);
          }
          if (failure) break;
        }
        const record: PerformanceRecord = failure
          ? {
              candidateId,
              scenarioId,
              campaign,
              repeats,
              status: "failure",
              error: failure,
            }
          : {
              candidateId,
              scenarioId,
              campaign,
              repeats,
              status: "completed",
              baseline: summarizePhases(baselineCold, baselineWarm),
              candidate: summarizePhases(candidateCold, candidateWarm),
              passed: quality.passesHpPerformanceGate({
                baselineColdP95Ms: nearestRankPercentile(baselineCold, 0.95),
                candidateColdP95Ms: nearestRankPercentile(candidateCold, 0.95),
                baselineWarmP95Ms: nearestRankPercentile(baselineWarm, 0.95),
                candidateWarmP95Ms: nearestRankPercentile(candidateWarm, 0.95),
              }),
            };
        if (record.status === "completed") {
          for (const summary of [
            record.baseline.cold,
            record.baseline.warm,
            record.candidate.cold,
            record.candidate.warm,
          ]) {
            assertPhaseLatencyRecordConsistency(summary);
          }
        }
        records.push(record);
        report.performance.records = records;
        await writeHpStudyReport(REPORT_FILE, report);
      }
    }
  }

  report.performance.status = candidateIds.every((candidateId) =>
    SCENARIO_IDS.every((scenarioId) => {
      const matching = records.filter(
        (record) => record.candidateId === candidateId && record.scenarioId === scenarioId,
      );
      return matching.length === campaignCount;
    }),
  )
    ? "completed"
    : "pending";
  Object.assign(report.performance, {
    measurementProtocol: {
      campaigns: campaignCount,
      repeats,
      order: "ABBA",
      phases: ["instance_cold", "allocation_warm"],
      percentileEstimator: "nearest_rank_ceil",
      quantiles: { p50: 0.5, p95: 0.95 },
      scenarioIds: SCENARIO_IDS,
    },
  });
  await writeHpStudyReport(REPORT_FILE, report);
  console.log(
    JSON.stringify(
      { status: report.performance.status, records: records.length, output: REPORT_FILE.pathname },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}

type PerformanceRecord =
  | {
      candidateId: string;
      scenarioId: string;
      campaign: number;
      repeats: number;
      status: "completed";
      baseline: { cold: CompletedPhaseLatencyRecord; warm: CompletedPhaseLatencyRecord };
      candidate: { cold: CompletedPhaseLatencyRecord; warm: CompletedPhaseLatencyRecord };
      passed: boolean;
    }
  | {
      candidateId: string;
      scenarioId: string;
      campaign: number;
      repeats: number;
      status: "failure";
      error: string;
    };

async function measurePair(
  wasm: Uint8Array,
  candidate: import("./min-ef-hp-model").HpCandidate,
  scenario: import("./scenarios/fixed-grid").SolverScenario,
  factory: typeof import("./min-ef-hp-policy").createHpLadderSession,
  supplyForecast: import("../src/wasm/rustTypes").SupplyForecastContext,
): Promise<
  { status: "completed"; coldMs: number; warmMs: number } | { status: "failure"; error: string }
> {
  const [minEfInstance, phase2Instance] = await Promise.all([instantiate(wasm), instantiate(wasm)]);
  const session = factory(minEfInstance, phase2Instance, candidate, supplyForecast);
  try {
    const input = { start: scenario.start, stock: scenario.stock, strategy: "supply" as const };
    const cold = session.screenRoot(input, scenario.id);
    const warm = session.screenRoot(input, scenario.id);
    if (!cold.metrics || !warm.metrics) {
      return {
        status: "failure",
        error: cold.errorMessage ?? warm.errorMessage ?? "solver outcome changed to failure",
      };
    }
    return { status: "completed", coldMs: cold.elapsedMs, warmMs: warm.elapsedMs };
  } finally {
    session.release();
  }
}

function summarizePhases(cold: number[], warm: number[]) {
  return {
    cold: summarizePhase(cold),
    warm: summarizePhase(warm),
  };
}

function summarizePhase(samplesMs: number[]): CompletedPhaseLatencyRecord {
  return summarizePhaseLatencySamples(samplesMs);
}

function readTailConfirmation(tailRisk: { records: unknown[] }): Array<{
  candidateId: string;
  passed: boolean;
}> {
  const value = tailRisk as { confirmationDecisions?: unknown };
  if (!Array.isArray(value.confirmationDecisions)) return [];
  return value.confirmationDecisions.filter(
    (entry): entry is { candidateId: string; passed: boolean } =>
      typeof entry === "object" &&
      entry !== null &&
      "candidateId" in entry &&
      typeof entry.candidateId === "string" &&
      "passed" in entry &&
      typeof entry.passed === "boolean",
  );
}

async function instantiate(wasm: Uint8Array): Promise<WebAssembly.Instance> {
  const result = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return result instanceof WebAssembly.Instance ? result : result.instance;
}
