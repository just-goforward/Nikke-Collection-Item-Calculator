import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import {
  type AvailabilityScreenReport,
  readScreenReport,
} from "./availability-deep-slice-state.ts";
import {
  baselineIncompleteDeepExactSummary,
  collectDeepTrajectorySummary,
  type DeepExactSummary,
  type DeepJourneyPanelSummary,
  type DeepTrajectorySummary,
  maxCompletedPanelSupplyDebt,
  summarizeDeepExact,
  withSupplyDebtStatus,
} from "./availability-deep-summary.ts";
import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";
import type { AvailabilitySliderCandidate } from "./models/availability-grid";
import {
  envValue,
  isErrorWithCode,
  parseList,
  parsePositiveInteger,
  parseSeeds,
} from "./runner-utils";
import type { SolverScenario } from "./scenarios/fixed-grid";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const SCREEN_FILE = new URL("./results/availability-screen.json", import.meta.url);
const OUTPUT_FILE = new URL("./results/availability-deep.json", import.meta.url);

// Gate/guardrail scenarios: scarcity/realistic only. balanced300 is EXCLUDED here (zero gate
// information at P ~ 0.99999, most expensive exact) and used only as a journey panel.
const DEFAULT_SCENARIO_IDS = [
  "R0-balanced100",
  "SR0-balanced100",
  "R14e900-yellow30",
  "SR5-blue30",
  "SR10-blue10",
  "SR10-yellow10",
];
// Journey-demand panels resolved from journey-panels.ts; disjoint from the scenarios above.
const DEFAULT_JOURNEY_PANEL_IDS = ["R0-balanced300", "SR0-balanced300"];
const DEFAULT_SEEDS = [20260505, 20260506, 20260507, 20260508];

function scenarioById(scenarios: readonly SolverScenario[], id: string): SolverScenario {
  const scenario = scenarios.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Missing scenario: ${id}`);
  return scenario;
}

function candidateById(
  candidates: readonly AvailabilitySliderCandidate[],
  id: string,
): AvailabilitySliderCandidate {
  const candidate = candidates.find((item) => item.id === id);
  if (!candidate) throw new Error(`Missing availability candidate: ${id}`);
  return candidate;
}

await mkdir(RESULTS_DIRECTORY, { recursive: true });

let screenReport: AvailabilityScreenReport | null = null;
try {
  screenReport = readScreenReport(JSON.parse(await readFile(SCREEN_FILE, "utf8")));
} catch (error) {
  if (!isErrorWithCode(error) || error.code !== "ENOENT") throw error;
}

const exactBudgetMs = parsePositiveInteger(envValue("AVAILABILITY_DEEP_EXACT_BUDGET_MS"), 300_000);
const trajectoryBudgetMs = parsePositiveInteger(
  envValue("AVAILABILITY_DEEP_TRAJECTORY_BUDGET_MS"),
  300_000,
);
const runsPerSeed = parsePositiveInteger(envValue("AVAILABILITY_DEEP_RUNS_PER_SEED"), 12_000);
const seeds = parseSeeds(envValue("AVAILABILITY_DEEP_SEEDS"), DEFAULT_SEEDS);
const scenarioIds = parseList(envValue("AVAILABILITY_DEEP_SCENARIOS"), DEFAULT_SCENARIO_IDS);
const journeyPanelIds = parseList(
  envValue("AVAILABILITY_DEEP_JOURNEY_PANELS"),
  DEFAULT_JOURNEY_PANEL_IDS,
);
const requestedCandidateIds = parseList(
  envValue("AVAILABILITY_DEEP_CANDIDATES"),
  screenReport?.deepCandidateIds || ["tau0.01-h0.5-p3"],
);

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const grid = (await server.ssrLoadModule(
    "/benchmarks/scenarios/fixed-grid.ts",
  )) as typeof import("./scenarios/fixed-grid");
  const journey = (await server.ssrLoadModule(
    "/benchmarks/scenarios/journey-panels.ts",
  )) as typeof import("./scenarios/journey-panels");
  const availability = (await server.ssrLoadModule(
    "/benchmarks/models/availability-grid.ts",
  )) as typeof import("./models/availability-grid");
  const exact = (await server.ssrLoadModule(
    "/benchmarks/evaluator/exact-replan.ts",
  )) as typeof import("./evaluator/exact-replan");
  const trajectory = (await server.ssrLoadModule(
    "/benchmarks/evaluator/trajectory.ts",
  )) as typeof import("./evaluator/trajectory");
  const metrics = (await server.ssrLoadModule(
    "/benchmarks/metrics.ts",
  )) as typeof import("./metrics");

  const allCandidates = availability.buildAvailabilityGridCandidates({
    includePreservationProbes: true,
    includeSensitivityProbes: true,
  });
  const candidates = requestedCandidateIds.map((id) => candidateById(allCandidates, id));
  const scenarios = scenarioIds.map((id) => scenarioById(grid.FIXED_SAFETY_GRID, id));
  const journeyPanels = journeyPanelIds.map((id) => journey.journeyPanelById(id));

  // Gate/guardrail scenarios and journey-demand panels must be disjoint (correction #1/#3).
  const gateScenarioIds = new Set(scenarios.map((scenario) => scenario.id));
  const panelOverlap = journeyPanels.filter((panel) => gateScenarioIds.has(panel.id));
  if (panelOverlap.length > 0) {
    throw new Error(
      `Journey panels must be disjoint from gate/guardrail scenarios; overlap: ${panelOverlap
        .map((panel) => panel.id)
        .join(", ")}.`,
    );
  }
  const startedAt = performance.now();

  function exactOptions(candidate: AvailabilitySliderCandidate) {
    return {
      modelId: candidate.id,
      costModel: availability.availabilityCostModelFor(candidate),
      toleranceOverride: candidate.tolerance,
      timeBudgetMs: exactBudgetMs,
    };
  }

  function collectTrajectorySummary(
    scenario: SolverScenario,
    candidate: AvailabilitySliderCandidate,
  ): DeepTrajectorySummary {
    return collectDeepTrajectorySummary({
      scenario,
      candidate,
      seeds,
      runsPerSeed,
      trajectoryBudgetMs,
      availability,
      metrics,
      trajectory,
    });
  }

  const baselineCandidate = availability.BASELINE_AVAILABILITY_CANDIDATE;
  const exactBaselineByScenario = new Map<string, ExactInteractiveEvaluation>();
  for (const scenario of scenarios) {
    const result = exact.evaluateExactInteractiveReplan(scenario, exactOptions(baselineCandidate));
    exactBaselineByScenario.set(scenario.id, result);
  }

  const exactResults: DeepExactSummary[] = [];
  const finiteStockTail: DeepTrajectorySummary[] = [];
  const journeyDemand: Array<{
    candidateId: string;
    panels: DeepJourneyPanelSummary[];
    maxPanelSupplyDebtCvar90: number | null;
  }> = [];

  for (const candidate of candidates) {
    for (const scenario of scenarios) {
      const baselineResult = exactBaselineByScenario.get(scenario.id);
      if (!baselineResult) throw new Error(`Missing baseline exact result for ${scenario.id}`);
      // If the baseline A could not be verified exactly on this scenario, no candidate's
      // exactLossVsA is computable, so skip the (potentially expensive) candidate exact run and
      // record it as baseline_incomplete instead of wasting the budget (correction #5).
      if (candidate.id !== baselineCandidate.id && baselineResult?.status !== "completed") {
        exactResults.push(baselineIncompleteDeepExactSummary(scenario.id, candidate.id));
        finiteStockTail.push(collectTrajectorySummary(scenario, candidate));
        continue;
      }
      const exactResult =
        candidate.id === baselineCandidate.id
          ? baselineResult
          : exact.evaluateExactInteractiveReplan(scenario, exactOptions(candidate));
      exactResults.push(summarizeDeepExact(exactResult, baselineResult));
      finiteStockTail.push(collectTrajectorySummary(scenario, candidate));
    }

    const panelResults: DeepJourneyPanelSummary[] = [];
    for (const panel of journeyPanels) {
      const panelSummary = collectTrajectorySummary(panel, candidate);
      panelResults.push(withSupplyDebtStatus(panelSummary));
    }
    journeyDemand.push({
      candidateId: candidate.id,
      panels: panelResults,
      maxPanelSupplyDebtCvar90: maxCompletedPanelSupplyDebt(panelResults),
    });
  }

  const report = {
    kind: "availability-deep",
    version: 1,
    generatedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - startedAt),
    options: {
      exactBudgetMs,
      trajectoryBudgetMs,
      runsPerSeed,
      seeds,
      scenarioIds,
      journeyPanelIds,
      candidateIds: candidates.map((candidate) => candidate.id),
    },
    exactResults,
    finiteStockTail,
    journeyDemand,
  };

  await writeFile(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        kind: report.kind,
        elapsedMs: report.elapsedMs,
        candidates: candidates.length,
        scenarios: scenarios.length,
        journeyPanels: journeyPanels.length,
        exactResults: exactResults.length,
        finiteStockTail: finiteStockTail.length,
        journeyDemand: journeyDemand.length,
        output: OUTPUT_FILE.pathname,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
