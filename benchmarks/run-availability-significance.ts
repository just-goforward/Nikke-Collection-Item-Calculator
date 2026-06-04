// Significance step: CRN paired bootstrap + Holm-Bonferroni for the supplyDebt y-axis.
//
// This turns the preservation contract's "strictly better tail" into a statistically significant
// improvement, not just a noisy point estimate. The pass is standalone: it reads deep results,
// selects preservation contenders, and re-collects only their journey-panel trajectories plus A.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import type { TrajectoryEvaluation } from "./evaluator/trajectory";
import type { AvailabilitySliderCandidate } from "./models/availability-grid";
import { isErrorWithCode, parsePositiveInteger } from "./runner-utils";
import type { SolverScenario } from "./scenarios/fixed-grid";
import type { SeedSamples } from "./significance-gate";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const SLICE_FILE = new URL("./results/availability-deep-slice.json", import.meta.url);
const SINGLE_FILE = new URL("./results/availability-deep.json", import.meta.url);
const OUTPUT_FILE = new URL("./results/availability-significance.json", import.meta.url);

const BASELINE_ID = "tau0.01-h0.5-p3";
const EPS = 1e-9;

type DeepJourneyDemandEntry = {
  candidateId: string;
  maxPanelSupplyDebtCvar90: number | null;
};

type DeepExactEntry = {
  modelId: string;
  status: string;
  exactLossVsA?: number | null;
};

type DeepConfig = {
  journeyPanelIds?: string[];
  seeds?: number[];
  runsPerSeed?: number;
};

type DeepReport = {
  journeyDemand: DeepJourneyDemandEntry[];
  exactResults: DeepExactEntry[];
  config?: DeepConfig;
  options?: DeepConfig;
};

type LoadedDeepReport = {
  report: DeepReport;
  source: string;
};

type PanelArray =
  | {
      status: "completed";
      perSeed: SeedSamples[];
    }
  | {
      status: Extract<TrajectoryEvaluation, { status: "verification_incomplete" }>["status"];
      reason: Extract<TrajectoryEvaluation, { status: "verification_incomplete" }>["reason"];
      perSeed: null;
    };

function panelArrayFailureReason(array: PanelArray): string | null {
  return array.status === "completed" ? null : array.reason;
}

type CompletedPanelSignificance = {
  panel: string;
  status: "completed";
  pointImprovement: number;
  confidenceLower: number;
  confidenceUpper: number;
  adversePValue: number;
  completionMin: number;
  seedsKept: number;
  seedsTotal: number;
  seedsGated: unknown[];
};

type IncompletePanelSignificance = {
  panel: string;
  status: "judgement_incomplete";
  reason: string | null;
  completionMin?: number;
  seedsKept?: number;
  seedsTotal?: number;
  seedsGated?: unknown[];
};

type CandidateSignificance = {
  candidateId: string;
  perPanel: Array<CompletedPanelSignificance | IncompletePanelSignificance>;
  judgeable: boolean;
  allPanelsCiPositive: boolean;
  adversePValue: number;
};

function parseNumber(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readDeepReport(value: unknown): DeepReport {
  if (typeof value !== "object" || value === null) {
    return { journeyDemand: [], exactResults: [] };
  }
  return {
    journeyDemand:
      "journeyDemand" in value && Array.isArray(value.journeyDemand)
        ? value.journeyDemand.filter(
            (entry): entry is DeepJourneyDemandEntry =>
              typeof entry === "object" &&
              entry !== null &&
              "candidateId" in entry &&
              typeof entry.candidateId === "string",
          )
        : [],
    exactResults:
      "exactResults" in value && Array.isArray(value.exactResults)
        ? value.exactResults.filter(
            (entry): entry is DeepExactEntry =>
              typeof entry === "object" &&
              entry !== null &&
              "modelId" in entry &&
              typeof entry.modelId === "string" &&
              "status" in entry &&
              typeof entry.status === "string",
          )
        : [],
    config: "config" in value ? (value.config as DeepConfig) : undefined,
    options: "options" in value ? (value.options as DeepConfig) : undefined,
  };
}

async function loadDeep(): Promise<LoadedDeepReport> {
  for (const file of [SLICE_FILE, SINGLE_FILE]) {
    try {
      return {
        report: readDeepReport(JSON.parse(await readFile(file, "utf8"))),
        source: file.pathname,
      };
    } catch (error) {
      if (!isErrorWithCode(error) || error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("No deep-evaluation results found. Run the deep stage first.");
}

function pointSupplyDebt(report: DeepReport, modelId: string): number | null {
  const entry = report.journeyDemand.find((candidate) => candidate.candidateId === modelId);
  const value = entry ? Number(entry.maxPanelSupplyDebtCvar90) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function worstExactLoss(report: DeepReport, modelId: string): number | null {
  if (modelId === BASELINE_ID) return 0;
  const losses = report.exactResults
    .filter((entry) => entry.modelId === modelId && entry.status === "completed")
    .map((entry) => Number(entry.exactLossVsA))
    .filter((value) => Number.isFinite(value));
  return losses.length ? Math.max(...losses) : null;
}

function readConfig(report: DeepReport): Required<DeepConfig> {
  const config = report.config || report.options || {};
  return {
    journeyPanelIds: config.journeyPanelIds || ["R0-balanced300", "SR0-balanced300"],
    seeds: config.seeds || [20260505, 20260506, 20260507, 20260508],
    runsPerSeed: parsePositiveInteger(String(config.runsPerSeed ?? ""), 12_000),
  };
}

const resamples = parsePositiveInteger(process.env.AVAILABILITY_SIG_RESAMPLES, 10_000);
const confidence = parseNumber(process.env.AVAILABILITY_SIG_CONFIDENCE, 0.95);
const alpha = parseNumber(process.env.AVAILABILITY_SIG_ALPHA, 0.05);
const cvarAlpha = parseNumber(process.env.AVAILABILITY_SIG_CVAR_ALPHA, 0.9);
const bootstrapSeed = parsePositiveInteger(process.env.AVAILABILITY_SIG_SEED, 20260505);
const deltaPBudget = parseNumber(process.env.AVAILABILITY_SELECT_DELTA_P_BUDGET, 0.005);
const completionThreshold = parseNumber(process.env.AVAILABILITY_SIG_COMPLETION_THRESHOLD, 0.995);
const trajectoryBudgetMs = parsePositiveInteger(
  process.env.AVAILABILITY_SIG_TRAJECTORY_BUDGET_MS,
  1_200_000,
);

await mkdir(RESULTS_DIRECTORY, { recursive: true });
const { report, source } = await loadDeep();
const { journeyPanelIds, seeds, runsPerSeed } = readConfig(report);

const aDebt = pointSupplyDebt(report, BASELINE_ID);
const allModelIds = Array.from(
  new Set([
    ...report.journeyDemand.map((entry) => entry.candidateId),
    ...report.exactResults.map((entry) => entry.modelId),
  ]),
);

const contenders: string[] = [];
if (aDebt !== null) {
  for (const modelId of allModelIds) {
    if (modelId === BASELINE_ID) continue;
    const debt = pointSupplyDebt(report, modelId);
    const loss = worstExactLoss(report, modelId);
    if (debt === null || loss === null) continue;
    if (debt < aDebt - EPS && loss <= deltaPBudget + EPS) contenders.push(modelId);
  }
}

const forcedContenders = (process.env.AVAILABILITY_SIG_FORCE_CONTENDERS || "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id && id !== BASELINE_ID && !contenders.includes(id));
for (const id of forcedContenders) contenders.push(id);

const baseOutput = {
  kind: "availability-significance",
  version: 1,
  generatedAt: new Date().toISOString(),
  source,
  baselineId: BASELINE_ID,
  journeyPanelIds,
  seeds,
  runsPerSeed,
  resamples,
  confidence,
  alpha,
  cvarAlpha,
  completionThreshold,
  baselinePointSupplyDebt: aDebt,
  deltaPBudget,
};

if (aDebt === null || contenders.length === 0) {
  const out = {
    ...baseOutput,
    contenders,
    candidates: [],
    note:
      aDebt === null
        ? "Baseline A journey supplyDebt is unjudgeable; cannot test improvement significance."
        : "No preservation contender (no candidate has point supplyDebt below A within deltaPBudget). Nothing to test.",
  };
  await writeFile(OUTPUT_FILE, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ kind: out.kind, contenders, note: out.note }, null, 2));
  process.exit(0);
}

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const journey = (await server.ssrLoadModule(
    "/benchmarks/scenarios/journey-panels.ts",
  )) as typeof import("./scenarios/journey-panels");
  const availability = (await server.ssrLoadModule(
    "/benchmarks/models/availability-grid.ts",
  )) as typeof import("./models/availability-grid");
  const trajectory = (await server.ssrLoadModule(
    "/benchmarks/evaluator/trajectory.ts",
  )) as typeof import("./evaluator/trajectory");
  const metrics = (await server.ssrLoadModule(
    "/benchmarks/metrics.ts",
  )) as typeof import("./metrics");
  const stats = (await server.ssrLoadModule(
    "/benchmarks/tail-statistics.ts",
  )) as typeof import("./tail-statistics");
  const gate = (await server.ssrLoadModule(
    "/benchmarks/significance-gate.ts",
  )) as typeof import("./significance-gate");

  const allCandidates = availability.buildAvailabilityGridCandidates({
    includePreservationProbes: true,
    includeSensitivityProbes: true,
  });
  const byId = new Map<string, AvailabilitySliderCandidate>(
    allCandidates.map((candidate) => [candidate.id, candidate]),
  );
  const cvar90 = (values: number[]) => metrics.cvarUpperTail(values, cvarAlpha);

  function collectPanelArray(modelId: string, panel: SolverScenario): PanelArray {
    const candidate = byId.get(modelId);
    if (!candidate) throw new Error(`Unknown candidate ${modelId}`);
    const perSeed: SeedSamples[] = [];
    for (const seed of seeds) {
      const result = trajectory.collectInteractiveTrajectories(panel, {
        modelId,
        costModel: availability.availabilityCostModelFor(candidate),
        toleranceOverride: candidate.tolerance,
        runs: runsPerSeed,
        seed,
        timeBudgetMs: trajectoryBudgetMs,
      });
      if (result.status !== "completed") {
        return { status: result.status, reason: result.reason, perSeed: null };
      }
      const samples = result.samples.map((sample) => metrics.maxSupplyDebtDays(sample.consumption));
      const completed = result.samples.filter((sample) => sample.completed).length;
      perSeed.push({
        seed,
        completionRate: result.samples.length ? completed / result.samples.length : 0,
        samples,
      });
    }
    return { status: "completed", perSeed };
  }

  const panels = journeyPanelIds.map((id) => journey.journeyPanelById(id));
  const baselineArrays = new Map<string, PanelArray>();
  for (const panel of panels) baselineArrays.set(panel.id, collectPanelArray(BASELINE_ID, panel));

  const candidateResults: CandidateSignificance[] = [];
  for (const modelId of contenders) {
    const perPanel: CandidateSignificance["perPanel"] = [];
    for (const panel of panels) {
      const baseArr = baselineArrays.get(panel.id);
      if (!baseArr) throw new Error(`Missing baseline panel array for ${panel.id}`);
      const candArr = collectPanelArray(modelId, panel);
      if (baseArr.status !== "completed" || candArr.status !== "completed") {
        const baseReason = panelArrayFailureReason(baseArr);
        const candReason = panelArrayFailureReason(candArr);
        perPanel.push({
          panel: panel.id,
          status: "judgement_incomplete",
          reason: baseReason ? `baseline:${baseReason}` : candReason,
        });
        continue;
      }

      const gated = gate.gatePairedSeeds(baseArr.perSeed, candArr.perSeed, completionThreshold);
      if (gated.status !== "completed") {
        perPanel.push({
          panel: panel.id,
          status: "judgement_incomplete",
          reason: gated.reason,
          completionMin: gated.completionMin,
          seedsKept: gated.seedsKept,
          seedsTotal: gated.seedsTotal,
          seedsGated: gated.seedsGated,
        });
        continue;
      }

      const display = stats.pairedBootstrapImprovement(gated.basePool, gated.candPool, {
        higherIsBetter: false,
        statistic: cvar90,
        resamples,
        confidence,
        seed: bootstrapSeed,
      });
      const improveTest = stats.pairedBootstrapImprovement(gated.candPool, gated.basePool, {
        higherIsBetter: false,
        statistic: cvar90,
        resamples,
        confidence,
        seed: bootstrapSeed,
      });
      perPanel.push({
        panel: panel.id,
        status: "completed",
        pointImprovement: display.pointImprovement,
        confidenceLower: display.confidenceLower,
        confidenceUpper: display.confidenceUpper,
        adversePValue: improveTest.adversePValue,
        completionMin: gated.completionMin,
        seedsKept: gated.seedsKept,
        seedsTotal: gated.seedsTotal,
        seedsGated: gated.seedsGated,
      });
    }

    const completed = perPanel.filter(
      (panel): panel is CompletedPanelSignificance => panel.status === "completed",
    );
    const judgeable = completed.length === perPanel.length && perPanel.length > 0;
    const allPanelsCiPositive = judgeable && completed.every((panel) => panel.confidenceLower > 0);
    const adversePValue = judgeable
      ? Math.max(...completed.map((panel) => panel.adversePValue))
      : 1;
    candidateResults.push({
      candidateId: modelId,
      perPanel,
      judgeable,
      allPanelsCiPositive,
      adversePValue,
    });
  }

  const holm = stats.holmBonferroniWorseningDecisions(
    candidateResults.map((candidate) => ({
      id: candidate.candidateId,
      adversePValue: candidate.adversePValue,
    })),
    alpha,
  );
  const holmById = new Map(holm.map((decision) => [decision.id, decision]));

  const candidates = candidateResults.map((candidate) => {
    const decision = holmById.get(candidate.candidateId);
    const holmConfirmedImprovement = Boolean(decision?.confirmedWorsening) && candidate.judgeable;
    return {
      ...candidate,
      holmThreshold: decision ? decision.threshold : null,
      holmConfirmedImprovement,
      significantImprovement: candidate.allPanelsCiPositive && holmConfirmedImprovement,
    };
  });

  const out = {
    ...baseOutput,
    contenders,
    candidates,
    note: "significantImprovement = (all panels CI lower > 0) AND Holm-confirmed at alpha.",
  };
  await writeFile(OUTPUT_FILE, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        kind: out.kind,
        contenders,
        significant: candidates
          .filter((candidate) => candidate.significantImprovement)
          .map((candidate) => candidate.candidateId),
        output: OUTPUT_FILE.pathname,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
