import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "vite";
import {
  activeSupplyForecastContext,
  validateSupplyForecastContext,
} from "../src/wasm/rustCoreShared.ts";
import type { SupplyForecastContext } from "../src/wasm/rustTypes.ts";

import {
  type HpStudyReport,
  readExactCheckpoint,
  readHpStudyReport,
  shouldAdvanceExactEvaluation,
  summarizeLadderTraces,
  writeExactCheckpoint,
  writeHpStudyReport,
} from "./min-ef-hp-report.ts";
import { envValue, parseList, parsePositiveInteger } from "./runner-utils.ts";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const DEFAULT_OUTPUT_FILE = new URL("./results/min-ef-hp-study.json", import.meta.url);
const outputFileValue = envValue("HP_STUDY_REPORT_FILE");
const OUTPUT_FILE = outputFileValue
  ? new URL(outputFileValue, RESULTS_DIRECTORY)
  : DEFAULT_OUTPUT_FILE;
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const EXACT_SCENARIO_IDS = [
  "R0-balanced100",
  "SR0-balanced100",
  "R14e900-yellow30",
  "SR5-blue30",
  "SR10-blue10",
  "SR10-yellow10",
  "R0-balanced300",
  "R10-balanced300",
  "SR0-balanced300",
  "R0-observedBalanced",
  "SR0-observedPurpleHigh",
] as const;

const stage = envValue("HP_STUDY_STAGE") ?? "screen";
if (stage !== "screen" && stage !== "exact") {
  throw new Error("HP_STUDY_STAGE must be screen or exact for this runner.");
}
const exactSliceBudgetMs = parsePositiveInteger(envValue("HP_STUDY_EXACT_BUDGET_MS"), 120_000);
const maxNewRecords = parsePositiveInteger(
  envValue("HP_STUDY_MAX_NEW_RECORDS"),
  Number.MAX_SAFE_INTEGER,
);
const supplyContextValue = envValue("HP_STUDY_SUPPLY_CONTEXT");
const supplyForecast = supplyContextValue
  ? validateSupplyForecastContext(JSON.parse(supplyContextValue) as SupplyForecastContext)
  : activeSupplyForecastContext();
const CHECKPOINT_DIRECTORY = new URL(
  `./min-ef-hp-checkpoints/${safePathSegment(supplyForecast.forecastProfileId)}/`,
  RESULTS_DIRECTORY,
);

await mkdir(RESULTS_DIRECTORY, { recursive: true });
await mkdir(CHECKPOINT_DIRECTORY, { recursive: true });
const wasm = await readFile(WASM_URL);
const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false },
});

try {
  const model = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-model.ts",
  )) as typeof import("./min-ef-hp-model");
  const selection = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-selection.ts",
  )) as typeof import("./min-ef-hp-selection");
  const policy = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-policy.ts",
  )) as typeof import("./min-ef-hp-policy");
  const quality = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-quality.ts",
  )) as typeof import("./min-ef-hp-quality");
  const tail = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-tail.ts",
  )) as typeof import("./min-ef-hp-tail");
  const evaluator = (await server.ssrLoadModule(
    "/benchmarks/evaluator/exact-replan.ts",
  )) as typeof import("./evaluator/exact-replan");
  const fixed = (await server.ssrLoadModule(
    "/benchmarks/scenarios/fixed-grid.ts",
  )) as typeof import("./scenarios/fixed-grid");
  const product = (await server.ssrLoadModule(
    "/benchmarks/scenarios/rerank-product.ts",
  )) as typeof import("./scenarios/rerank-product");
  const supplemental = (await server.ssrLoadModule(
    "/benchmarks/scenarios/rerank-supplemental.ts",
  )) as typeof import("./scenarios/rerank-supplemental");

  const allScenarios = [
    ...fixed.FIXED_SAFETY_GRID,
    ...product.PRODUCT_RERANK_SCENARIOS,
    ...supplemental.RERANK_SUPPLEMENTAL_SCENARIOS,
  ];
  const scenarioById = new Map(allScenarios.map((scenario) => [scenario.id, scenario]));
  for (const scenarioId of EXACT_SCENARIO_IDS) {
    if (!scenarioById.has(scenarioId)) throw new Error(`Missing exact H/p scenario ${scenarioId}.`);
  }

  const storedReport = await readHpStudyReport(OUTPUT_FILE);
  const canonicalReport =
    !supplyContextValue && !storedReport && OUTPUT_FILE.href !== DEFAULT_OUTPUT_FILE.href
      ? await readHpStudyReport(DEFAULT_OUTPUT_FILE)
      : null;
  let report =
    storedReport ??
    (canonicalReport ? structuredClone(canonicalReport) : null) ??
    createInitialReport({
      candidates: model.HP_CANDIDATES,
      scenarioIds: allScenarios.map((scenario) => scenario.id),
      exactSliceBudgetMs,
      baselineId: model.HP_BASELINE_ID,
      qualityPolicy: quality.HP_QUALITY_POLICY,
      performancePolicy: quality.HP_PERFORMANCE_POLICY,
      tailPolicy: tail.HP_TAIL_POLICY,
      supplyForecast,
    });
  if (report.options.exactSliceBudgetMs !== exactSliceBudgetMs) {
    throw new Error("HP_STUDY_EXACT_BUDGET_MS does not match the stored study contract.");
  }
  if (JSON.stringify(report.options.supplyForecast) !== JSON.stringify(supplyForecast)) {
    throw new Error("HP_STUDY_SUPPLY_CONTEXT does not match the stored study contract.");
  }

  if (stage === "screen") {
    let newRecords = 0;
    const candidateIds = parseList(
      envValue("HP_STUDY_CANDIDATES"),
      model.HP_CANDIDATES.map((candidate) => candidate.id),
    );
    const scenarioIds = parseList(
      envValue("HP_STUDY_SCENARIOS"),
      allScenarios.map((scenario) => scenario.id),
    );
    screenCandidates: for (const candidateId of candidateIds) {
      const candidate = model.hpCandidateById(candidateId);
      const session = await createSession(
        wasm,
        candidate,
        policy.createHpLadderSession,
        supplyForecast,
      );
      try {
        for (const scenarioId of scenarioIds) {
          if (
            report.screening.records.some(
              (record) => record.candidateId === candidateId && record.scenarioId === scenarioId,
            )
          ) {
            continue;
          }
          const scenario = scenarioById.get(scenarioId);
          if (!scenario) throw new Error(`Unknown H/p screening scenario ${scenarioId}.`);
          session.release();
          report.screening.records.push(
            session.screenRoot(
              { start: scenario.start, stock: scenario.stock, strategy: "supply" },
              scenario.id,
            ),
          );
          report = refreshScreening(report, model, selection, scenarioById);
          await writeHpStudyReport(OUTPUT_FILE, report);
          newRecords += 1;
          if (newRecords >= maxNewRecords) break screenCandidates;
        }
      } finally {
        session.release();
      }
    }
    report = refreshScreening(report, model, selection, scenarioById);
    await writeHpStudyReport(OUTPUT_FILE, report);
  } else {
    if (!report.screening.complete) {
      throw new Error("Complete all 49 x 122 root screening records before exact evaluation.");
    }
    const candidateIds = parseList(envValue("HP_STUDY_CANDIDATES"), report.screening.shortlistIds);
    const scenarioIds = parseList(envValue("HP_STUDY_SCENARIOS"), EXACT_SCENARIO_IDS);
    let newRecords = 0;
    exactCandidates: for (const candidateId of candidateIds) {
      const candidate = model.hpCandidateById(candidateId);
      for (const scenarioId of scenarioIds) {
        const existing = report.exact.records.find(
          (record) => record.candidateId === candidateId && record.scenarioId === scenarioId,
        );
        if (!shouldAdvanceExactEvaluation(existing?.evaluation)) continue;
        const scenario = scenarioById.get(scenarioId);
        if (!scenario) throw new Error(`Unknown H/p exact scenario ${scenarioId}.`);
        const session = await createSession(
          wasm,
          candidate,
          policy.createHpLadderSession,
          supplyForecast,
        );
        const checkpointUrl = exactCheckpointUrl(candidateId, scenarioId);
        try {
          const checkpoint = await readExactCheckpoint(checkpointUrl);
          const exactSession = evaluator.createExactInteractiveReplanSession(
            scenario,
            {
              modelId: candidateId,
              policySolver: session.policySolver,
              toleranceOverride: 0,
            },
            checkpoint,
          );
          const evaluation = exactSession.advance(exactSliceBudgetMs);
          upsertExactRecord(report, {
            candidateId,
            scenarioId,
            evaluation,
            ladderOutcomes: summarizeLadderTraces(session.traces()),
          });
          if (evaluation.status === "verification_incomplete") {
            await writeExactCheckpoint(checkpointUrl, exactSession.checkpoint());
          } else {
            await rm(checkpointUrl, { force: true });
          }
          refreshExact(report, model.HP_BASELINE_ID, quality.evaluateHpExactGate);
          await writeHpStudyReport(OUTPUT_FILE, report);
          newRecords += 1;
          if (newRecords >= maxNewRecords) break exactCandidates;
        } finally {
          session.release();
        }
      }
    }
    refreshExact(report, model.HP_BASELINE_ID, quality.evaluateHpExactGate);
    await writeHpStudyReport(OUTPUT_FILE, report);
  }

  console.log(
    JSON.stringify(
      {
        stage,
        screening: {
          complete: report.screening.complete,
          records: report.screening.records.length,
          shortlistIds: report.screening.shortlistIds,
        },
        exact: {
          complete: report.exact.complete,
          records: report.exact.records.length,
          finalistIds: report.exact.finalistIds,
        },
        output: OUTPUT_FILE.pathname,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}

async function createSession(
  wasm: Uint8Array,
  candidate: import("./min-ef-hp-model").HpCandidate,
  factory: typeof import("./min-ef-hp-policy").createHpLadderSession,
  supplyContext: SupplyForecastContext,
) {
  const [minEfInstance, phase2Instance] = await Promise.all([instantiate(wasm), instantiate(wasm)]);
  return factory(minEfInstance, phase2Instance, candidate, supplyContext);
}

async function instantiate(wasm: Uint8Array): Promise<WebAssembly.Instance> {
  const instantiated = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
}

function createInitialReport(input: {
  candidates: import("./min-ef-hp-model").HpCandidate[];
  scenarioIds: string[];
  exactSliceBudgetMs: number;
  baselineId: string;
  qualityPolicy: Record<string, unknown>;
  performancePolicy: Record<string, unknown>;
  tailPolicy: Record<string, unknown>;
  supplyForecast: SupplyForecastContext;
}): HpStudyReport {
  return {
    kind: "min-ef-hp-study",
    version: 2,
    generatedAt: new Date().toISOString(),
    options: {
      candidates: input.candidates,
      scenarioIds: input.scenarioIds,
      exactScenarioIds: [...EXACT_SCENARIO_IDS],
      tolerance: 0,
      minEfMemoTier: 21,
      phase2MemoTier: 22,
      exactSliceBudgetMs: input.exactSliceBudgetMs,
      supplyForecast: input.supplyForecast,
    },
    measurementProtocol: {
      performanceLatency: {
        orderedSamples: true,
        phases: ["instance_cold", "allocation_warm"],
        quantiles: { p50: 0.5, p95: 0.95 },
        percentileEstimator: "nearest_rank_ceil",
        campaignOrder: "ABBA",
      },
    },
    decisionPolicy: {
      quality: input.qualityPolicy,
      performance: input.performancePolicy,
      tailRisk: input.tailPolicy,
    },
    decisionScope: { researchOnly: true, productAdoptionAuthorized: false },
    baselineVerification: { candidateId: input.baselineId, status: "pending", notes: [] },
    screening: { complete: false, records: [], summaries: [], shortlistIds: [] },
    exact: { complete: false, records: [], gates: [], finalistIds: [] },
    tailRisk: { status: "pending", records: [] },
    d1Robustness: { status: "pending", records: [] },
    performance: { status: "pending", records: [] },
    candidateGrades: [],
  };
}

function refreshScreening(
  report: HpStudyReport,
  model: typeof import("./min-ef-hp-model"),
  selection: typeof import("./min-ef-hp-selection"),
  scenarioById: Map<string, import("./scenarios/fixed-grid").SolverScenario>,
): HpStudyReport {
  for (const record of report.screening.records) {
    if (!record.metrics) continue;
    const scenario = scenarioById.get(record.scenarioId);
    if (!scenario) continue;
    record.metrics.optimizerExpectedCost = model.hpAvailabilityObjective(
      record.metrics.expectedConsumption,
      scenario.stock,
      model.hpCandidateById(record.candidateId),
    );
  }
  report.screening.summaries = model.summarizeHpScreening(report.screening.records);
  report.screening.complete =
    report.screening.records.length ===
    report.options.candidates.length * report.options.scenarioIds.length;
  report.screening.shortlistIds = report.screening.complete
    ? selection.selectHpShortlist(report.screening.summaries)
    : [];
  return report;
}

function upsertExactRecord(
  report: HpStudyReport,
  record: HpStudyReport["exact"]["records"][number],
): void {
  const index = report.exact.records.findIndex(
    (entry) => entry.candidateId === record.candidateId && entry.scenarioId === record.scenarioId,
  );
  if (index < 0) report.exact.records.push(record);
  else report.exact.records[index] = record;
}

function refreshExact(
  report: HpStudyReport,
  baselineId: string,
  evaluateGate: typeof import("./min-ef-hp-quality").evaluateHpExactGate,
): void {
  const baselineByScenario = new Map(
    report.exact.records
      .filter((record) => record.candidateId === baselineId)
      .map((record) => [record.scenarioId, record.evaluation]),
  );
  report.exact.gates = report.exact.records.flatMap((record) => {
    const baseline = baselineByScenario.get(record.scenarioId);
    return baseline
      ? [
          {
            candidateId: record.candidateId,
            scenarioId: record.scenarioId,
            gate: evaluateGate(baseline, record.evaluation),
          },
        ]
      : [];
  });
  report.exact.complete = report.screening.shortlistIds.every((candidateId) =>
    report.options.exactScenarioIds.every((scenarioId) => {
      const record = report.exact.records.find(
        (entry) => entry.candidateId === candidateId && entry.scenarioId === scenarioId,
      );
      return record && record.evaluation.status !== "verification_incomplete";
    }),
  );
  if (!report.exact.complete) {
    report.exact.finalistIds = [];
    return;
  }
  const passing = report.screening.shortlistIds.filter((candidateId) => {
    const gates = report.exact.gates.filter((entry) => entry.candidateId === candidateId);
    return (
      gates.length === report.options.exactScenarioIds.length &&
      gates.every((entry) => entry.gate.status === "passed")
    );
  });
  report.exact.finalistIds = passing
    .sort((left, right) => exactCandidatePriority(report, left, right, baselineId))
    .slice(0, 4);
}

function exactCandidatePriority(
  report: HpStudyReport,
  leftId: string,
  rightId: string,
  baselineId: string,
): number {
  if (leftId === baselineId) return -1;
  if (rightId === baselineId) return 1;
  const rootDebt = (candidateId: string) =>
    report.screening.summaries.find((summary) => summary.candidateId === candidateId)
      ?.worstSupplyDebtDays ?? Number.POSITIVE_INFINITY;
  const meanUses = (candidateId: string) => {
    const records = report.exact.records.filter(
      (record) => record.candidateId === candidateId && record.evaluation.status === "completed",
    );
    return (
      records.reduce((sum, record) => {
        if (record.evaluation.status !== "completed") return sum;
        const stock = record.evaluation.expectedConsumption;
        return sum + (stock.blue + stock.purple + stock.yellow) / 10;
      }, 0) / Math.max(1, records.length)
    );
  };
  return (
    rootDebt(leftId) - rootDebt(rightId) ||
    meanUses(leftId) - meanUses(rightId) ||
    leftId.localeCompare(rightId)
  );
}

function exactCheckpointUrl(candidateId: string, scenarioId: string): URL {
  return new URL(`${candidateId}/${scenarioId}.json`, CHECKPOINT_DIRECTORY);
}

function safePathSegment(value: string): string {
  const safe = value.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") {
    throw new Error("Supply forecast profile ID cannot be used as a checkpoint namespace.");
  }
  return safe;
}
