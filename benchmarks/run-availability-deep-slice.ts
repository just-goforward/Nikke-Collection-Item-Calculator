import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "vite";
import {
  type AvailabilityScreenReport,
  type DeepSliceConfig,
  type DeepSliceState,
  readDeepSliceState,
  readScreenReport,
  sameExactConfig,
} from "./availability-deep-slice-state.ts";
import {
  completedBaselineForScenario,
  incompleteBaselineForScenario,
  summarizeExact,
  trajectoryJobSummary,
  writeDeepSliceOutputs,
} from "./availability-deep-slice-summary.ts";
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
// journey-demand panel below.
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

const reset = envValue("AVAILABILITY_DEEP_SLICE_RESET") === "1";
const sliceMs = parsePositiveInteger(envValue("AVAILABILITY_DEEP_SLICE_MS"), 300_000);
const exactTotalBudgetMs = parsePositiveInteger(
  envValue("AVAILABILITY_DEEP_EXACT_BUDGET_MS"),
  300_000,
);
// Per-trajectory-job hard cap. Trajectory jobs are NOT resumable (unlike the exact session), so
// this must fit inside one slice: the tail phases require sliceMs >= trajectoryBudgetMs.
const trajectoryBudgetMs = parsePositiveInteger(
  envValue("AVAILABILITY_DEEP_TRAJECTORY_BUDGET_MS"),
  120_000,
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

  function requireJob<T>(jobs: readonly T[], index: number, label: string): T {
    const job = jobs[index];
    if (!job) throw new Error(`Missing ${label} job at index ${index}.`);
    return job;
  }

  while (remainingSliceMs() > 0) {
    if (state.phase === "exact") {
      if (state.exactJobIndex >= exactJobs.length) {
        state.phase = "finite-tail";
        state.exactSessionCheckpoint = null;
        continue;
      }
      const job = requireJob(exactJobs, state.exactJobIndex, "exact");
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
      const job = requireJob(finiteTailJobs, state.finiteTailJobIndex, "finite-tail");
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
      const pendingJob = requireJob(journeyTailJobs, state.journeyTailJobIndex, "journey-tail");
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
      const job = requireJob(journeyTailJobs, state.journeyTailJobIndex, "journey-tail");
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

  const report = await writeDeepSliceOutputs(state, baselineCandidate.id, {
    outputFile: OUTPUT_FILE,
    checkpointFile: CHECKPOINT_FILE,
  });
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
