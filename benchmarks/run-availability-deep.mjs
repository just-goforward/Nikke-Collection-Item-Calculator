import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const SCREEN_FILE = new URL("./results/availability-screen.json", import.meta.url);
const OUTPUT_FILE = new URL("./results/availability-deep.json", import.meta.url);

// Gate/guardrail scenarios: scarcity/realistic only. balanced300 is EXCLUDED here (zero gate
// information at P ~ 0.99999, most expensive exact) and used only as a journey panel.
// (See REPORT.ko.md, correction #1.)
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

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function parseList(value, fallback) {
  const parsed = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function parseSeeds(value) {
  return parseList(value, DEFAULT_SEEDS.map(String)).map((seed) =>
    parseNonNegativeInteger(seed, 0),
  );
}

function summarizeExact(result, baseline) {
  const common = {
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    scenario: result.scenario.id,
    modelId: result.modelId,
    elapsedMs: result.elapsedMs,
    solveCalls: result.solveCalls,
    cachedNodes: result.cachedNodes,
    cachedPolicies: result.cachedPolicies,
    gateEvidence: result.gateEvidence,
  };
  if (result.status !== "completed") return common;
  const baselineP =
    baseline && baseline.status === "completed" ? baseline.successProbability : Number.NaN;
  return {
    ...common,
    successProbability: result.successProbability,
    exactLossVsA: Number.isFinite(baselineP) ? baselineP - result.successProbability : null,
    relativeLossVsA:
      Number.isFinite(baselineP) && baselineP > 0
        ? (baselineP - result.successProbability) / baselineP
        : null,
    expectedConsumption: result.expectedConsumption,
    interactiveF: result.interactiveF,
    manualEntryProbability: result.manualEntryProbability,
    expectedManualEntries: result.expectedManualEntries,
    successAttemptSelectionProbability: result.successAttemptSelectionProbability,
    expectedSuccessAttemptSelections: result.expectedSuccessAttemptSelections,
  };
}

function scenarioById(scenarios, id) {
  const scenario = scenarios.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Missing scenario: ${id}`);
  return scenario;
}

function candidateById(candidates, id) {
  const candidate = candidates.find((item) => item.id === id);
  if (!candidate) throw new Error(`Missing availability candidate: ${id}`);
  return candidate;
}

await mkdir(RESULTS_DIRECTORY, { recursive: true });

let screenReport = null;
try {
  screenReport = JSON.parse(await readFile(SCREEN_FILE, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const exactBudgetMs = parsePositiveInteger(process.env.AVAILABILITY_DEEP_EXACT_BUDGET_MS, 300_000);
const trajectoryBudgetMs = parsePositiveInteger(
  process.env.AVAILABILITY_DEEP_TRAJECTORY_BUDGET_MS,
  300_000,
);
const runsPerSeed = parsePositiveInteger(process.env.AVAILABILITY_DEEP_RUNS_PER_SEED, 12_000);
const seeds = parseSeeds(process.env.AVAILABILITY_DEEP_SEEDS);
const scenarioIds = parseList(process.env.AVAILABILITY_DEEP_SCENARIOS, DEFAULT_SCENARIO_IDS);
const journeyPanelIds = parseList(
  process.env.AVAILABILITY_DEEP_JOURNEY_PANELS,
  DEFAULT_JOURNEY_PANEL_IDS,
);
const requestedCandidateIds = parseList(
  process.env.AVAILABILITY_DEEP_CANDIDATES,
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
  const grid = await server.ssrLoadModule("/benchmarks/scenarios/fixed-grid.ts");
  const journey = await server.ssrLoadModule("/benchmarks/scenarios/journey-panels.ts");
  const availability = await server.ssrLoadModule("/benchmarks/models/availability-grid.ts");
  const exact = await server.ssrLoadModule("/benchmarks/evaluator/exact-replan.ts");
  const trajectory = await server.ssrLoadModule("/benchmarks/evaluator/trajectory.ts");
  const metrics = await server.ssrLoadModule("/benchmarks/metrics.ts");

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

  function exactOptions(candidate) {
    return {
      modelId: candidate.id,
      costModel: availability.availabilityCostModelFor(candidate),
      toleranceOverride: candidate.tolerance,
      timeBudgetMs: exactBudgetMs,
    };
  }

  function collectTrajectorySummary(scenario, candidate) {
    const samples = [];
    const evaluations = [];
    for (const seed of seeds) {
      const result = trajectory.collectInteractiveTrajectories(scenario, {
        modelId: candidate.id,
        costModel: availability.availabilityCostModelFor(candidate),
        toleranceOverride: candidate.tolerance,
        runs: runsPerSeed,
        seed,
        timeBudgetMs: trajectoryBudgetMs,
      });
      if (result.status !== "completed") {
        return {
          status: result.status,
          reason: result.reason,
          scenario: scenario.id,
          modelId: candidate.id,
          seed,
          runsCompleted: result.runsCompleted,
          elapsedMs: result.elapsedMs,
          solveCalls: result.solveCalls,
          cachedPolicies: result.cachedPolicies,
        };
      }
      evaluations.push({
        seed,
        runs: result.runs,
        elapsedMs: result.elapsedMs,
        solveCalls: result.solveCalls,
        cachedPolicies: result.cachedPolicies,
      });
      samples.push(...result.samples);
    }
    return {
      status: "completed",
      scenario: scenario.id,
      modelId: candidate.id,
      seeds,
      runsPerSeed,
      totalRuns: samples.length,
      evaluations,
      summary: metrics.summarizeTrajectories(samples),
    };
  }

  const baselineCandidate = availability.BASELINE_AVAILABILITY_CANDIDATE;
  const exactBaselineByScenario = new Map();
  for (const scenario of scenarios) {
    const result = exact.evaluateExactInteractiveReplan(scenario, exactOptions(baselineCandidate));
    exactBaselineByScenario.set(scenario.id, result);
  }

  const exactResults = [];
  const finiteStockTail = [];
  const journeyDemand = [];

  for (const candidate of candidates) {
    for (const scenario of scenarios) {
      const baselineResult = exactBaselineByScenario.get(scenario.id);
      // If the baseline A could not be verified exactly on this scenario, no candidate's
      // exactLossVsA is computable, so skip the (potentially expensive) candidate exact run and
      // record it as baseline_incomplete instead of wasting the budget (correction #5).
      if (candidate.id !== baselineCandidate.id && baselineResult?.status !== "completed") {
        exactResults.push({
          status: "verification_incomplete",
          reason: "baseline_incomplete",
          scenario: scenario.id,
          modelId: candidate.id,
        });
        finiteStockTail.push(collectTrajectorySummary(scenario, candidate));
        continue;
      }
      const exactResult =
        candidate.id === baselineCandidate.id
          ? baselineResult
          : exact.evaluateExactInteractiveReplan(scenario, exactOptions(candidate));
      exactResults.push(summarizeExact(exactResult, baselineResult));
      finiteStockTail.push(collectTrajectorySummary(scenario, candidate));
    }

    const panelResults = [];
    for (const panel of journeyPanels) {
      const panelSummary = collectTrajectorySummary(panel, candidate);
      panelResults.push({
        ...panelSummary,
        supplyDebtStatus:
          panelSummary.status === "completed" && panelSummary.summary.completionRate >= 0.995
            ? "completed"
            : "judgement_incomplete",
      });
    }
    const completedPanelDebtValues = panelResults
      .filter((panel) => panel.status === "completed" && panel.supplyDebtStatus === "completed")
      .map((panel) => panel.summary.maxSupplyDebtDaysCvar90);
    journeyDemand.push({
      candidateId: candidate.id,
      panels: panelResults,
      maxPanelSupplyDebtCvar90:
        completedPanelDebtValues.length > 0 ? Math.max(...completedPanelDebtValues) : null,
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
