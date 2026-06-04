import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import type {
  ExactInteractiveEvaluation,
  ExactInteractiveReplanCheckpoint,
} from "./evaluator/exact-replan";
import type { TrajectoryEvaluation } from "./evaluator/trajectory";
import type { TrajectoryTailSummary } from "./metrics";
import type { AvailabilitySliderCandidate } from "./models/availability-grid";
import { isErrorWithCode, parseList, parsePositiveInteger, parseSeeds } from "./runner-utils";
import type { SolverScenario } from "./scenarios/fixed-grid";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const SCREEN_FILE = new URL("./results/availability-screen.json", import.meta.url);
const CHECKPOINT_FILE = new URL(
  "./results/availability-deep-slice.checkpoint.json",
  import.meta.url,
);
const OUTPUT_FILE = new URL("./results/availability-deep-slice.json", import.meta.url);

// Exact P-loss GATE + finite-stock GUARDRAIL scenarios.
// These are scarcity/realistic scenarios where success probability is genuinely at risk (so the
// exact P-loss gate is informative) and where exact evaluation completes inside the per-job
// budget. balanced300 is intentionally EXCLUDED: on it every candidate completes with
// P ~ 0.99999, so exact P-loss vs A ~ 0 (zero gate information) while exact is the most
// expensive (R0-balanced300 ~ 610s, always times out at 300s). balanced300 is used ONLY as a
// journey-demand panel below. (See REPORT.ko.md, correction #1.)
const DEFAULT_SCENARIO_IDS = [
  "R0-balanced100",
  "SR0-balanced100",
  "R14e900-yellow30",
  "SR5-blue30",
  "SR10-blue10",
  "SR10-yellow10",
];
// Journey-demand panels (Pareto y-axis source) are resolved from journey-panels.ts and MUST be
// disjoint from the gate/guardrail scenarios above (asserted at runtime).
const DEFAULT_JOURNEY_PANEL_IDS = ["R0-balanced300", "SR0-balanced300"];
const DEFAULT_SEEDS = [20260505, 20260506, 20260507, 20260508];

type DeepSliceConfig = {
  candidateIds: string[];
  scenarioIds: string[];
  journeyPanelIds: string[];
  seeds: number[];
  runsPerSeed: number;
  exactTotalBudgetMs: number;
  trajectoryBudgetMs: number;
};

type AvailabilityScreenReport = {
  deepCandidateIds?: string[];
};

type ExactSummary = {
  status: ExactInteractiveEvaluation["status"];
  reason?: string;
  scenario: string;
  modelId: string;
  elapsedMs: number;
  solveCalls: number;
  cachedNodes: number;
  cachedPolicies: number;
  gateEvidence: ExactInteractiveEvaluation["gateEvidence"] | null;
  successProbability?: number;
  exactLossVsA?: number | null;
  relativeLossVsA?: number | null;
  expectedConsumption?: Extract<
    ExactInteractiveEvaluation,
    { status: "completed" }
  >["expectedConsumption"];
  interactiveF?: number;
  manualEntryProbability?: number;
  expectedManualEntries?: number;
  successAttemptSelectionProbability?: number;
  expectedSuccessAttemptSelections?: number;
};

type TrajectoryJobSummary =
  | {
      status: "completed";
      scenario: string;
      modelId: string;
      seed: number;
      runs: number;
      elapsedMs: number;
      solveCalls: number;
      cachedPolicies: number;
      summary: TrajectoryTailSummary;
    }
  | {
      status: Extract<TrajectoryEvaluation, { status: "verification_incomplete" }>["status"];
      reason: Extract<TrajectoryEvaluation, { status: "verification_incomplete" }>["reason"];
      scenario: string;
      modelId: string;
      seed: number;
      runsCompleted: number;
      elapsedMs: number;
      solveCalls: number;
      cachedPolicies: number;
    };

type JourneyPanelSummary = TrajectoryJobSummary & {
  supplyDebtStatus: "completed" | "judgement_incomplete";
};

type JourneyDemandSummary = {
  candidateId: string;
  panels: JourneyPanelSummary[];
  maxPanelSupplyDebtCvar90: number | null;
};

type DeepSliceState = {
  version: 1;
  config: DeepSliceConfig;
  phase: "exact" | "finite-tail" | "journey-tail" | "completed";
  exactJobIndex: number;
  exactSessionCheckpoint: ExactInteractiveReplanCheckpoint | null;
  exactResults: ExactSummary[];
  finiteTailJobIndex: number;
  finiteStockTail: TrajectoryJobSummary[];
  journeyTailJobIndex: number;
  journeyTail: TrajectoryJobSummary[];
};

function readScreenReport(value: unknown): AvailabilityScreenReport | null {
  if (typeof value !== "object" || value === null) return null;
  return {
    deepCandidateIds:
      "deepCandidateIds" in value && Array.isArray(value.deepCandidateIds)
        ? value.deepCandidateIds.filter((id): id is string => typeof id === "string")
        : undefined,
  };
}

function readDeepSliceState(value: unknown, expectedConfig: DeepSliceConfig): DeepSliceState {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1) {
    throw new Error("Unsupported availability deep checkpoint version.");
  }
  return {
    version: 1,
    config: "config" in value ? (value.config as DeepSliceConfig) : expectedConfig,
    phase:
      "phase" in value &&
      (value.phase === "exact" ||
        value.phase === "finite-tail" ||
        value.phase === "journey-tail" ||
        value.phase === "completed")
        ? value.phase
        : "exact",
    exactJobIndex:
      "exactJobIndex" in value && typeof value.exactJobIndex === "number" ? value.exactJobIndex : 0,
    exactSessionCheckpoint:
      "exactSessionCheckpoint" in value
        ? (value.exactSessionCheckpoint as ExactInteractiveReplanCheckpoint | null)
        : null,
    exactResults:
      "exactResults" in value && Array.isArray(value.exactResults)
        ? (value.exactResults as ExactSummary[])
        : [],
    finiteTailJobIndex:
      "finiteTailJobIndex" in value && typeof value.finiteTailJobIndex === "number"
        ? value.finiteTailJobIndex
        : 0,
    finiteStockTail:
      "finiteStockTail" in value && Array.isArray(value.finiteStockTail)
        ? (value.finiteStockTail as TrajectoryJobSummary[])
        : [],
    journeyTailJobIndex:
      "journeyTailJobIndex" in value && typeof value.journeyTailJobIndex === "number"
        ? value.journeyTailJobIndex
        : 0,
    journeyTail:
      "journeyTail" in value && Array.isArray(value.journeyTail)
        ? (value.journeyTail as TrajectoryJobSummary[])
        : [],
  };
}

function stateConfig(): DeepSliceConfig {
  return {
    candidateIds: requestedCandidateIds,
    scenarioIds,
    journeyPanelIds,
    seeds,
    runsPerSeed,
    exactTotalBudgetMs,
    trajectoryBudgetMs,
  };
}

function comparableExactConfig(config: DeepSliceConfig): Omit<DeepSliceConfig, "journeyPanelIds"> {
  return {
    candidateIds: config.candidateIds,
    scenarioIds: config.scenarioIds,
    seeds: config.seeds,
    runsPerSeed: config.runsPerSeed,
    exactTotalBudgetMs: config.exactTotalBudgetMs,
    trajectoryBudgetMs: config.trajectoryBudgetMs,
  };
}

function sameExactConfig(left: DeepSliceConfig, right: DeepSliceConfig): boolean {
  // journeyPanelIds is intentionally excluded: the exact-gate and finite-stock-tail phases do not
  // depend on journey panels, so adding/removing a journey panel must NOT invalidate those
  // (expensive) phases. Journey-panel changes are reconciled additively at checkpoint load.
  return (
    JSON.stringify(comparableExactConfig(left)) === JSON.stringify(comparableExactConfig(right))
  );
}

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

function summarizeExact(result: ExactInteractiveEvaluation): ExactSummary {
  const common = {
    status: result.status,
    ...(result.status !== "completed" ? { reason: result.reason } : {}),
    scenario: result.scenario.id,
    modelId: result.modelId,
    elapsedMs: result.elapsedMs,
    solveCalls: result.solveCalls,
    cachedNodes: result.cachedNodes,
    cachedPolicies: result.cachedPolicies,
    gateEvidence: result.gateEvidence,
  };
  if (result.status !== "completed") return common;
  return {
    ...common,
    successProbability: result.successProbability,
    expectedConsumption: result.expectedConsumption,
    interactiveF: result.interactiveF,
    manualEntryProbability: result.manualEntryProbability,
    expectedManualEntries: result.expectedManualEntries,
    successAttemptSelectionProbability: result.successAttemptSelectionProbability,
    expectedSuccessAttemptSelections: result.expectedSuccessAttemptSelections,
  };
}

function isCompletedExactSummary(
  result: ExactSummary,
): result is ExactSummary & { status: "completed"; successProbability: number } {
  return result.status === "completed" && typeof result.successProbability === "number";
}

function withExactLosses(
  exactResults: readonly ExactSummary[],
  baselineId: string,
): ExactSummary[] {
  const baselineByScenario = new Map<string, number>();
  for (const result of exactResults) {
    if (result.modelId === baselineId && isCompletedExactSummary(result)) {
      baselineByScenario.set(result.scenario, result.successProbability);
    }
  }
  return exactResults.map((result) => {
    if (!isCompletedExactSummary(result)) return result;
    const baselineP = baselineByScenario.get(result.scenario);
    return {
      ...result,
      exactLossVsA: typeof baselineP === "number" ? baselineP - result.successProbability : null,
      relativeLossVsA:
        typeof baselineP === "number" && baselineP > 0
          ? (baselineP - result.successProbability) / baselineP
          : null,
    };
  });
}

function completedBaselineForScenario(
  exactResults: readonly ExactSummary[],
  baselineId: string,
  scenarioId: string,
): ExactSummary | undefined {
  return exactResults.find(
    (result) =>
      result.scenario === scenarioId &&
      result.modelId === baselineId &&
      result.status === "completed",
  );
}

function incompleteBaselineForScenario(
  exactResults: readonly ExactSummary[],
  baselineId: string,
  scenarioId: string,
): ExactSummary | undefined {
  return exactResults.find(
    (result) =>
      result.scenario === scenarioId &&
      result.modelId === baselineId &&
      result.status !== "completed",
  );
}

function trajectoryJobSummary(
  result: TrajectoryEvaluation,
  metrics: typeof import("./metrics"),
): TrajectoryJobSummary {
  if (result.status !== "completed") {
    return {
      status: result.status,
      reason: result.reason,
      scenario: result.scenario.id,
      modelId: result.modelId,
      seed: result.seed,
      runsCompleted: result.runsCompleted,
      elapsedMs: result.elapsedMs,
      solveCalls: result.solveCalls,
      cachedPolicies: result.cachedPolicies,
    };
  }
  return {
    status: "completed",
    scenario: result.scenario.id,
    modelId: result.modelId,
    seed: result.seed,
    runs: result.runs,
    elapsedMs: result.elapsedMs,
    solveCalls: result.solveCalls,
    cachedPolicies: result.cachedPolicies,
    summary: metrics.summarizeTrajectories(result.samples),
  };
}

function isCompletedJourneyPanel(panel: JourneyPanelSummary): panel is Extract<
  TrajectoryJobSummary,
  { status: "completed" }
> & {
  supplyDebtStatus: "completed";
} {
  return panel.status === "completed" && panel.supplyDebtStatus === "completed";
}

function aggregateJourneyDemand(
  journeyTail: readonly TrajectoryJobSummary[],
): JourneyDemandSummary[] {
  const grouped = new Map<string, JourneyDemandSummary>();
  for (const result of journeyTail) {
    const entry = grouped.get(result.modelId) || {
      candidateId: result.modelId,
      panels: [],
      maxPanelSupplyDebtCvar90: null,
    };
    const supplyDebtStatus: JourneyPanelSummary["supplyDebtStatus"] =
      result.status === "completed" && result.summary.completionRate >= 0.995
        ? "completed"
        : "judgement_incomplete";
    entry.panels.push({ ...result, supplyDebtStatus });
    grouped.set(result.modelId, entry);
  }
  return Array.from(grouped.values()).map((entry) => {
    const completedPanelDebtValues = entry.panels
      .filter(isCompletedJourneyPanel)
      .map((panel) => panel.summary.maxSupplyDebtDaysCvar90);
    return {
      ...entry,
      maxPanelSupplyDebtCvar90:
        completedPanelDebtValues.length > 0 ? Math.max(...completedPanelDebtValues) : null,
    };
  });
}

async function writeOutputs(state: DeepSliceState, baselineId: string) {
  const report = {
    kind: "availability-deep-slice",
    version: 1,
    generatedAt: new Date().toISOString(),
    config: state.config,
    phase: state.phase,
    exactJobIndex: state.exactJobIndex,
    finiteTailJobIndex: state.finiteTailJobIndex,
    journeyTailJobIndex: state.journeyTailJobIndex,
    exactResults: withExactLosses(state.exactResults, baselineId),
    finiteStockTail: state.finiteStockTail,
    journeyDemand: aggregateJourneyDemand(state.journeyTail),
  };
  await writeFile(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(CHECKPOINT_FILE, `${JSON.stringify(state)}\n`, "utf8");
  return report;
}

await mkdir(RESULTS_DIRECTORY, { recursive: true });

let screenReport: AvailabilityScreenReport | null = null;
try {
  screenReport = readScreenReport(JSON.parse(await readFile(SCREEN_FILE, "utf8")));
} catch (error) {
  if (!isErrorWithCode(error) || error.code !== "ENOENT") throw error;
}

const reset = process.env.AVAILABILITY_DEEP_SLICE_RESET === "1";
const sliceMs = parsePositiveInteger(process.env.AVAILABILITY_DEEP_SLICE_MS, 300_000);
const exactTotalBudgetMs = parsePositiveInteger(
  process.env.AVAILABILITY_DEEP_EXACT_BUDGET_MS,
  300_000,
);
// Per-trajectory-job hard cap. Trajectory jobs are NOT resumable (unlike the exact session), so
// this must fit inside one slice: the tail phases require sliceMs >= trajectoryBudgetMs.
const trajectoryBudgetMs = parsePositiveInteger(
  process.env.AVAILABILITY_DEEP_TRAJECTORY_BUDGET_MS,
  120_000,
);
const runsPerSeed = parsePositiveInteger(process.env.AVAILABILITY_DEEP_RUNS_PER_SEED, 12_000);
const seeds = parseSeeds(process.env.AVAILABILITY_DEEP_SEEDS, DEFAULT_SEEDS);
const scenarioIds = parseList(process.env.AVAILABILITY_DEEP_SCENARIOS, DEFAULT_SCENARIO_IDS);
const journeyPanelIds = parseList(
  process.env.AVAILABILITY_DEEP_JOURNEY_PANELS,
  DEFAULT_JOURNEY_PANEL_IDS,
);
const requestedCandidateIds = parseList(
  process.env.AVAILABILITY_DEEP_CANDIDATES,
  screenReport?.deepCandidateIds || ["tau0.01-h0.5-p3"],
);
const config = stateConfig();

if (reset) await rm(CHECKPOINT_FILE, { force: true });

let state: DeepSliceState = {
  version: 1,
  config,
  phase: "exact",
  exactJobIndex: 0,
  exactSessionCheckpoint: null,
  exactResults: [],
  finiteTailJobIndex: 0,
  finiteStockTail: [],
  journeyTailJobIndex: 0,
  journeyTail: [],
};

try {
  const saved = readDeepSliceState(JSON.parse(await readFile(CHECKPOINT_FILE, "utf8")), config);
  if (!sameExactConfig(saved.config, config)) {
    throw new Error(
      "Availability deep checkpoint config mismatch (non-journey fields). Set AVAILABILITY_DEEP_SLICE_RESET=1.",
    );
  }
  state = saved;
  // Reconcile a journey-panel change additively. Exact + finite-tail results are panel-independent
  // and are preserved; only the missing (candidate, panel, seed) journey jobs are (re-)run. This is
  // what lets a newly calibrated skewed panel be added without redoing the whole deep sweep.
  if (JSON.stringify(saved.config.journeyPanelIds) !== JSON.stringify(config.journeyPanelIds)) {
    const keptPanels = new Set(config.journeyPanelIds);
    state.journeyTail = state.journeyTail.filter((result) => keptPanels.has(result.scenario));
    state.journeyTailJobIndex = 0; // identity-skip (journey-tail loop) re-runs only missing jobs
    if (state.phase === "completed") state.phase = "journey-tail";
    state.config = config; // adopt the new panel set so subsequent slices see a matching config
  }
} catch (error) {
  if (!isErrorWithCode(error) || error.code !== "ENOENT") throw error;
}

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
  const baselineCandidate = availability.BASELINE_AVAILABILITY_CANDIDATE;
  const scenarios = scenarioIds.map((id) => scenarioById(grid.FIXED_SAFETY_GRID, id));
  const journeyPanels = journeyPanelIds.map((id) => journey.journeyPanelById(id));

  // The exact P-loss gate / finite-stock guardrails (scenarios) and the journey-demand
  // supplyDebt panels (journeyPanels) measure DIFFERENT things and must never overlap, or a
  // scarcity scenario's truncated consumption could leak into the supplyDebt y-axis.
  const gateScenarioIds = new Set(scenarios.map((scenario) => scenario.id));
  const panelOverlap = journeyPanels.filter((panel) => gateScenarioIds.has(panel.id));
  if (panelOverlap.length > 0) {
    throw new Error(
      `Journey panels must be disjoint from gate/guardrail scenarios; overlap: ${panelOverlap
        .map((panel) => panel.id)
        .join(", ")}.`,
    );
  }
  const exactJobs = scenarios.flatMap((scenario) => [
    { scenario, candidate: baselineCandidate },
    ...candidates
      .filter((candidate) => candidate.id !== baselineCandidate.id)
      .map((candidate) => ({ scenario, candidate })),
  ]);
  const finiteTailJobs = candidates.flatMap((candidate) =>
    scenarios.flatMap((scenario) => seeds.map((seed) => ({ candidate, scenario, seed }))),
  );
  const journeyTailJobs = candidates.flatMap((candidate) =>
    journeyPanels.flatMap((scenario) => seeds.map((seed) => ({ candidate, scenario, seed }))),
  );
  // Identity set of journey jobs already recorded, so resumed/additive runs skip them instead of
  // re-solving. Keyed by (candidate, panel, seed) rather than job index, so it stays correct even
  // when the panel set grows (the new panel's jobs interleave per candidate).
  const journeyJobKey = (candidateId: string, panelId: string, seed: number) =>
    `${candidateId}|${panelId}|${seed}`;
  const doneJourneyKeys = new Set(
    state.journeyTail.map((result) => journeyJobKey(result.modelId, result.scenario, result.seed)),
  );
  const sliceStartedAt = performance.now();

  function remainingSliceMs() {
    return sliceMs - (performance.now() - sliceStartedAt);
  }

  function assertTrajectoryFitsSlice() {
    if (sliceMs < trajectoryBudgetMs) {
      throw new Error(
        `Tail phases require AVAILABILITY_DEEP_SLICE_MS (${sliceMs}) >= ` +
          `AVAILABILITY_DEEP_TRAJECTORY_BUDGET_MS (${trajectoryBudgetMs}); trajectory jobs are not ` +
          `resumable and would be truncated at the slice boundary. Raise SLICE_MS or lower TRAJECTORY_BUDGET_MS.`,
      );
    }
  }

  function exactOptions(candidate: AvailabilitySliderCandidate, timeBudgetMs: number) {
    return {
      modelId: candidate.id,
      costModel: availability.availabilityCostModelFor(candidate),
      toleranceOverride: candidate.tolerance,
      timeBudgetMs,
    };
  }

  while (remainingSliceMs() > 0) {
    if (state.phase === "exact") {
      if (state.exactJobIndex >= exactJobs.length) {
        state.phase = "finite-tail";
        state.exactSessionCheckpoint = null;
        continue;
      }
      const job = exactJobs[state.exactJobIndex];
      if (
        job.candidate.id !== baselineCandidate.id &&
        incompleteBaselineForScenario(state.exactResults, baselineCandidate.id, job.scenario.id) &&
        !completedBaselineForScenario(state.exactResults, baselineCandidate.id, job.scenario.id)
      ) {
        state.exactResults.push({
          status: "verification_incomplete",
          reason: "baseline_incomplete",
          scenario: job.scenario.id,
          modelId: job.candidate.id,
          elapsedMs: 0,
          solveCalls: 0,
          cachedNodes: 0,
          cachedPolicies: 0,
          gateEvidence: null,
        });
        state.exactJobIndex += 1;
        state.exactSessionCheckpoint = null;
        continue;
      }
      const activeExactElapsedMs = state.exactSessionCheckpoint?.activeElapsedMs || 0;
      const remainingExactBudgetMs = exactTotalBudgetMs - activeExactElapsedMs;
      const budgetMs = Math.max(0, Math.min(remainingSliceMs(), remainingExactBudgetMs));
      const session = exact.createExactInteractiveReplanSession(
        job.scenario,
        exactOptions(job.candidate, budgetMs),
        state.exactSessionCheckpoint ?? undefined,
      );
      const result = session.advance(budgetMs);
      if (result.status === "completed") {
        state.exactResults.push(summarizeExact(result));
        state.exactJobIndex += 1;
        state.exactSessionCheckpoint = null;
        continue;
      }
      const checkpoint = session.checkpoint();
      if (
        remainingExactBudgetMs <= 0 ||
        budgetMs <= 0 ||
        checkpoint.activeElapsedMs >= exactTotalBudgetMs
      ) {
        state.exactResults.push(summarizeExact(result));
        state.exactJobIndex += 1;
        state.exactSessionCheckpoint = null;
        continue;
      }
      state.exactSessionCheckpoint = checkpoint;
      break;
    }

    if (state.phase === "finite-tail") {
      if (state.finiteTailJobIndex >= finiteTailJobs.length) {
        state.phase = "journey-tail";
        continue;
      }
      assertTrajectoryFitsSlice();
      // Trajectory jobs are not resumable: only start one if its full per-job budget fits in the
      // remaining slice, otherwise resume it next slice. This prevents a slice boundary from
      // truncating a job into a permanent verification_incomplete (correction #2).
      if (remainingSliceMs() < trajectoryBudgetMs) break;
      const job = finiteTailJobs[state.finiteTailJobIndex];
      const result = trajectory.collectInteractiveTrajectories(job.scenario, {
        modelId: job.candidate.id,
        costModel: availability.availabilityCostModelFor(job.candidate),
        toleranceOverride: job.candidate.tolerance,
        runs: runsPerSeed,
        seed: job.seed,
        timeBudgetMs: trajectoryBudgetMs,
      });
      state.finiteStockTail.push(trajectoryJobSummary(result, metrics));
      state.finiteTailJobIndex += 1;
      continue;
    }

    if (state.phase === "journey-tail") {
      if (state.journeyTailJobIndex >= journeyTailJobs.length) {
        state.phase = "completed";
        break;
      }
      const pendingJob = journeyTailJobs[state.journeyTailJobIndex];
      // Skip jobs already recorded (normal resume keeps the cursor ahead of these; additive
      // panel-add resets the cursor to 0 so this is what avoids re-running the existing panels).
      // The skip is free, so it must come before the slice-budget guard.
      if (
        doneJourneyKeys.has(
          journeyJobKey(pendingJob.candidate.id, pendingJob.scenario.id, pendingJob.seed),
        )
      ) {
        state.journeyTailJobIndex += 1;
        continue;
      }
      assertTrajectoryFitsSlice();
      // Same non-resumable guard as finite-tail. Journey panels (balanced300 etc.) are the
      // slowest trajectory jobs, so this guard is what keeps the supplyDebt y-axis from silently
      // losing data at slice boundaries (correction #2).
      if (remainingSliceMs() < trajectoryBudgetMs) break;
      const job = journeyTailJobs[state.journeyTailJobIndex];
      const result = trajectory.collectInteractiveTrajectories(job.scenario, {
        modelId: job.candidate.id,
        costModel: availability.availabilityCostModelFor(job.candidate),
        toleranceOverride: job.candidate.tolerance,
        runs: runsPerSeed,
        seed: job.seed,
        timeBudgetMs: trajectoryBudgetMs,
      });
      state.journeyTail.push(trajectoryJobSummary(result, metrics));
      doneJourneyKeys.add(journeyJobKey(job.candidate.id, job.scenario.id, job.seed));
      state.journeyTailJobIndex += 1;
      continue;
    }

    break;
  }

  const report = await writeOutputs(state, baselineCandidate.id);
  console.log(
    JSON.stringify(
      {
        kind: report.kind,
        phase: report.phase,
        exact: `${state.exactJobIndex}/${exactJobs.length}`,
        finiteTail: `${state.finiteTailJobIndex}/${finiteTailJobs.length}`,
        journeyTail: `${state.journeyTailJobIndex}/${journeyTailJobs.length}`,
        output: OUTPUT_FILE.pathname,
        checkpoint: CHECKPOINT_FILE.pathname,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
