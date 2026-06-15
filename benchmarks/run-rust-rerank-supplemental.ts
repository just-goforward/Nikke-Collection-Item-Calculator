import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { envValue } from "./runner-utils";
import type { SolverScenario } from "./scenarios/fixed-grid";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const JSON_OUTPUT_FILE = new URL("./results/rust-rerank-supplemental.json", import.meta.url);
const CSV_OUTPUT_FILE = new URL("./results/rust-rerank-supplemental.csv", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);

const HORIZON_FACTOR = 0.75;
const NORM_POWER = 3;
const TOLERANCE = 0;
const DEFAULT_RUNS = 2048;
const DEFAULT_SEED = 20260509;
const DEFAULT_HELD_OUT_SEED = 20260510;
const STRICT_EPSILON = 1e-12;

type ScenarioRecord = {
  scenarioId: string;
  status: "completed" | "no-action" | "error";
  errorMessage?: string;
  start: string;
  stockBlue: number;
  stockPurple: number;
  stockYellow: number;
  candidateCount: number;
  baselineFirstAction: string | null;
  selectedFirstAction: string | null;
  intervened: boolean;
  baselineSuccessProbability: number | null;
  selectedSuccessProbability: number | null;
  selectedProbabilityGap: number | null;
  inSampleBaselineExpectedCost: number | null;
  inSampleSelectedExpectedCost: number | null;
  inSampleDeltaVsBaseline: number | null;
  inSampleCompletionRate: number | null;
  heldOutBaselineExpectedCost: number | null;
  heldOutSelectedExpectedCost: number | null;
  heldOutDeltaVsBaseline: number | null;
  heldOutBaselineCompletionRate: number | null;
  heldOutSelectedCompletionRate: number | null;
  heldOutNonWorse: boolean | null;
  heldOutStrictImproved: boolean | null;
  elapsedMs: number;
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function parseList(value: string | undefined, fallback: readonly string[]): string[] {
  const parsed = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function stateLabel(scenario: SolverScenario) {
  const exp = scenario.start.exp ? `e${scenario.start.exp}` : "";
  return `${scenario.start.grade}${scenario.start.level}${exp}`;
}

function mean(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function summarize(records: ScenarioRecord[]) {
  const completed = records.filter((record) => record.status === "completed");
  const intervened = completed.filter((record) => record.intervened);
  const heldOutComparable = completed.filter((record) => record.heldOutDeltaVsBaseline !== null);
  const heldOutNonWorse = heldOutComparable.filter((record) => record.heldOutNonWorse);
  const heldOutStrictImproved = heldOutComparable.filter((record) => record.heldOutStrictImproved);
  const heldOutInterventions = heldOutComparable.filter((record) => record.intervened);
  const heldOutInterventionStrictImproved = heldOutInterventions.filter(
    (record) => record.heldOutStrictImproved,
  );
  return {
    scenarioCount: records.length,
    completedCount: completed.length,
    noActionCount: records.filter((record) => record.status === "no-action").length,
    errorCount: records.filter((record) => record.status === "error").length,
    interventionCount: intervened.length,
    interventionRate: completed.length > 0 ? intervened.length / completed.length : null,
    heldOutComparableCount: heldOutComparable.length,
    heldOutNonWorseCount: heldOutNonWorse.length,
    heldOutNonWorseRate:
      heldOutComparable.length > 0 ? heldOutNonWorse.length / heldOutComparable.length : null,
    heldOutStrictImprovedCount: heldOutStrictImproved.length,
    heldOutStrictImprovementRate:
      heldOutComparable.length > 0 ? heldOutStrictImproved.length / heldOutComparable.length : null,
    heldOutInterventionComparableCount: heldOutInterventions.length,
    heldOutInterventionStrictImprovedCount: heldOutInterventionStrictImproved.length,
    heldOutInterventionStrictImprovementRate:
      heldOutInterventions.length > 0
        ? heldOutInterventionStrictImproved.length / heldOutInterventions.length
        : null,
    meanInSampleDeltaVsBaseline: mean(
      completed
        .map((record) => record.inSampleDeltaVsBaseline)
        .filter((value): value is number => value !== null),
    ),
    meanHeldOutDeltaVsBaseline: mean(
      heldOutComparable
        .map((record) => record.heldOutDeltaVsBaseline)
        .filter((value): value is number => value !== null),
    ),
    meanElapsedMs: mean(completed.map((record) => record.elapsedMs)),
    maxElapsedMs: completed.reduce((max, record) => Math.max(max, record.elapsedMs), 0),
  };
}

const runs = parsePositiveInteger(envValue("RUST_RERANK_SUPPLEMENTAL_RUNS"), DEFAULT_RUNS);
const seed = parsePositiveInteger(envValue("RUST_RERANK_SUPPLEMENTAL_SEED"), DEFAULT_SEED);
const heldOutSeed = parsePositiveInteger(
  envValue("RUST_RERANK_SUPPLEMENTAL_HELD_OUT_SEED"),
  DEFAULT_HELD_OUT_SEED,
);
await mkdir(RESULTS_DIRECTORY, { recursive: true });

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

const rustCore = (await server.ssrLoadModule(
  "/src/wasm/rustCore.ts",
)) as typeof import("../src/wasm/rustCore");
const supplemental = (await server.ssrLoadModule(
  "/benchmarks/scenarios/rerank-supplemental.ts",
)) as typeof import("./scenarios/rerank-supplemental");

const scenarioIds = parseList(
  envValue("RUST_RERANK_SUPPLEMENTAL_SCENARIOS"),
  supplemental.RERANK_SUPPLEMENTAL_SCENARIOS.map((scenario) => scenario.id),
);

const records: ScenarioRecord[] = [];
const startedAt = performance.now();

try {
  const wasm = await readFile(WASM_URL);
  const instantiated = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  const instance =
    instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
  const solver = rustCore.createRustPhase2SolverFromInstance(instance);
  const scenarios = scenarioIds.map((id) => supplemental.rerankSupplementalScenarioById(id));

  for (const scenario of scenarios) {
    const scenarioStartedAt = performance.now();
    const common = {
      scenarioId: scenario.id,
      start: stateLabel(scenario),
      stockBlue: scenario.stock.blue,
      stockPurple: scenario.stock.purple,
      stockYellow: scenario.stock.yellow,
    };
    try {
      const rerank = solver.selectFirstActionByExpectedCost(
        scenario.start,
        scenario.stock,
        runs,
        seed,
        HORIZON_FACTOR,
        NORM_POWER,
        TOLERANCE,
      );
      if (!rerank?.baseline.firstAction || !rerank.selected.firstAction) {
        records.push({
          ...common,
          status: "no-action",
          candidateCount: rerank?.candidates.length ?? 0,
          baselineFirstAction: rerank?.baseline.firstAction ?? null,
          selectedFirstAction: rerank?.selected.firstAction ?? null,
          intervened: false,
          baselineSuccessProbability: rerank?.baseline.successProbability ?? null,
          selectedSuccessProbability: rerank?.selected.successProbability ?? null,
          selectedProbabilityGap: rerank?.selected.probabilityGap ?? null,
          inSampleBaselineExpectedCost: null,
          inSampleSelectedExpectedCost: rerank?.selected.expectedCost ?? null,
          inSampleDeltaVsBaseline: null,
          inSampleCompletionRate: rerank?.selected.completionRate ?? null,
          heldOutBaselineExpectedCost: null,
          heldOutSelectedExpectedCost: null,
          heldOutDeltaVsBaseline: null,
          heldOutBaselineCompletionRate: null,
          heldOutSelectedCompletionRate: null,
          heldOutNonWorse: null,
          heldOutStrictImproved: null,
          elapsedMs: Math.round(performance.now() - scenarioStartedAt),
        });
        continue;
      }

      const baselineCandidate = rerank.candidates.find(
        (candidate) => candidate.firstAction === rerank.baseline.firstAction,
      );
      const baselineInSample =
        baselineCandidate ??
        solver.estimateExpectedCostAfterFirstActionFromCurrent(
          scenario.start,
          scenario.stock,
          rerank.baseline.firstAction,
          runs,
          seed,
          HORIZON_FACTOR,
          NORM_POWER,
        );
      const heldOutSelected = solver.estimateExpectedCostAfterFirstActionFromCurrent(
        scenario.start,
        scenario.stock,
        rerank.selected.firstAction,
        runs,
        heldOutSeed,
        HORIZON_FACTOR,
        NORM_POWER,
      );
      const heldOutBaseline =
        rerank.baseline.firstAction === rerank.selected.firstAction
          ? heldOutSelected
          : solver.estimateExpectedCostAfterFirstActionFromCurrent(
              scenario.start,
              scenario.stock,
              rerank.baseline.firstAction,
              runs,
              heldOutSeed,
              HORIZON_FACTOR,
              NORM_POWER,
            );
      const heldOutDelta = heldOutSelected.expectedCost - heldOutBaseline.expectedCost;

      records.push({
        ...common,
        status: "completed",
        candidateCount: rerank.candidates.length,
        baselineFirstAction: rerank.baseline.firstAction,
        selectedFirstAction: rerank.selected.firstAction,
        intervened: rerank.baseline.firstAction !== rerank.selected.firstAction,
        baselineSuccessProbability: rerank.baseline.successProbability,
        selectedSuccessProbability: rerank.selected.successProbability,
        selectedProbabilityGap: rerank.selected.probabilityGap,
        inSampleBaselineExpectedCost: baselineInSample.expectedCost,
        inSampleSelectedExpectedCost: rerank.selected.expectedCost,
        inSampleDeltaVsBaseline: rerank.selected.expectedCost - baselineInSample.expectedCost,
        inSampleCompletionRate: rerank.selected.completionRate,
        heldOutBaselineExpectedCost: heldOutBaseline.expectedCost,
        heldOutSelectedExpectedCost: heldOutSelected.expectedCost,
        heldOutDeltaVsBaseline: heldOutDelta,
        heldOutBaselineCompletionRate: heldOutBaseline.completionRate,
        heldOutSelectedCompletionRate: heldOutSelected.completionRate,
        heldOutNonWorse: heldOutDelta <= STRICT_EPSILON,
        heldOutStrictImproved: heldOutDelta < -STRICT_EPSILON,
        elapsedMs: Math.round(performance.now() - scenarioStartedAt),
      });
    } catch (error) {
      records.push({
        ...common,
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        candidateCount: 0,
        baselineFirstAction: null,
        selectedFirstAction: null,
        intervened: false,
        baselineSuccessProbability: null,
        selectedSuccessProbability: null,
        selectedProbabilityGap: null,
        inSampleBaselineExpectedCost: null,
        inSampleSelectedExpectedCost: null,
        inSampleDeltaVsBaseline: null,
        inSampleCompletionRate: null,
        heldOutBaselineExpectedCost: null,
        heldOutSelectedExpectedCost: null,
        heldOutDeltaVsBaseline: null,
        heldOutBaselineCompletionRate: null,
        heldOutSelectedCompletionRate: null,
        heldOutNonWorse: null,
        heldOutStrictImproved: null,
        elapsedMs: Math.round(performance.now() - scenarioStartedAt),
      });
    }
  }

  const report = {
    kind: "rust-rerank-supplemental",
    version: 1,
    generatedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - startedAt),
    options: {
      runs,
      seed,
      heldOutSeed,
      horizonFactor: HORIZON_FACTOR,
      normPower: NORM_POWER,
      tolerance: TOLERANCE,
      scenarioIds,
    },
    summary: summarize(records),
    records,
  };

  await writeFile(JSON_OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const columns = [
    "scenarioId",
    "status",
    "start",
    "stockBlue",
    "stockPurple",
    "stockYellow",
    "candidateCount",
    "baselineFirstAction",
    "selectedFirstAction",
    "intervened",
    "baselineSuccessProbability",
    "selectedSuccessProbability",
    "selectedProbabilityGap",
    "inSampleBaselineExpectedCost",
    "inSampleSelectedExpectedCost",
    "inSampleDeltaVsBaseline",
    "inSampleCompletionRate",
    "heldOutBaselineExpectedCost",
    "heldOutSelectedExpectedCost",
    "heldOutDeltaVsBaseline",
    "heldOutBaselineCompletionRate",
    "heldOutSelectedCompletionRate",
    "heldOutNonWorse",
    "heldOutStrictImproved",
    "elapsedMs",
  ] as const satisfies ReadonlyArray<keyof ScenarioRecord>;
  const csv = [
    columns.join(","),
    ...records.map((record) => columns.map((column) => csvEscape(record[column])).join(",")),
  ].join("\n");
  await writeFile(CSV_OUTPUT_FILE, `${csv}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        kind: report.kind,
        elapsedMs: report.elapsedMs,
        summary: report.summary,
        json: JSON_OUTPUT_FILE.pathname,
        csv: CSV_OUTPUT_FILE.pathname,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
