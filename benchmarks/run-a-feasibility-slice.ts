import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import type {
  ExactInteractiveEvaluation,
  ExactInteractiveReplanCheckpoint,
} from "./evaluator/exact-replan";
import { isErrorWithCode, parsePositiveInteger } from "./runner-utils";
import type { SolverScenario } from "./scenarios/fixed-grid";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const CHECKPOINT_FILE = new URL("./results/a-feasibility.checkpoint.json", import.meta.url);
const DEFAULT_TOTAL_BUDGET_MS = 60 * 60 * 1000;
const DEFAULT_SLICE_MS = 30 * 1000;
const totalBudgetMs = parsePositiveInteger(
  process.env.A_FEASIBILITY_BUDGET_MS,
  DEFAULT_TOTAL_BUDGET_MS,
);
const sliceMs = parsePositiveInteger(process.env.A_FEASIBILITY_SLICE_MS, DEFAULT_SLICE_MS);
const reset = process.env.A_FEASIBILITY_RESET === "1";
const sentinelOrder = [
  "R0-balanced300",
  "SR0-balanced300",
  "R0-balanced100",
  "SR0-balanced100",
  "R14e900-yellow30",
];

type FeasibilityCompletedReport = {
  status: ExactInteractiveEvaluation["status"];
  scenario: string;
  elapsedMs: number;
  solveCalls: number;
  cachedNodes: number;
  cachedPolicies: number;
  gateEvidence: ExactInteractiveEvaluation["gateEvidence"];
  successProbability?: number;
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

type FeasibilityCheckpoint = {
  version: 1;
  sentinelIndex: number;
  completed: FeasibilityCompletedReport[];
  sessionCheckpoint: ExactInteractiveReplanCheckpoint | null;
};

function readFeasibilityCheckpoint(value: unknown): FeasibilityCheckpoint {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("sentinelIndex" in value) ||
    typeof value.sentinelIndex !== "number" ||
    !("completed" in value) ||
    !Array.isArray(value.completed)
  ) {
    throw new Error("Unsupported feasibility checkpoint version.");
  }
  return {
    version: 1,
    sentinelIndex: value.sentinelIndex,
    completed: value.completed as FeasibilityCompletedReport[],
    sessionCheckpoint:
      "sessionCheckpoint" in value
        ? (value.sessionCheckpoint as ExactInteractiveReplanCheckpoint | null)
        : null,
  };
}

await mkdir(RESULTS_DIRECTORY, { recursive: true });
if (reset) await rm(CHECKPOINT_FILE, { force: true });

let state: FeasibilityCheckpoint = {
  version: 1,
  sentinelIndex: 0,
  completed: [],
  sessionCheckpoint: null,
};
try {
  state = readFeasibilityCheckpoint(JSON.parse(await readFile(CHECKPOINT_FILE, "utf8")));
} catch (error) {
  if (!isErrorWithCode(error) || error.code !== "ENOENT") throw error;
}

const elapsedBeforeCurrent =
  state.completed.reduce((sum, result) => sum + result.elapsedMs, 0) +
  (state.sessionCheckpoint?.activeElapsedMs || 0);
const remainingBudgetMs = totalBudgetMs - elapsedBeforeCurrent;
if (remainingBudgetMs <= 0 && state.sentinelIndex < sentinelOrder.length) {
  console.error(
    `[A feasibility slice] total budget exhausted after ${elapsedBeforeCurrent}ms; reset or revise the gate before continuing.`,
  );
  process.exitCode = 1;
} else if (state.sentinelIndex >= sentinelOrder.length) {
  console.log(`[A feasibility slice] already completed ${state.completed.length} sentinels.`);
} else {
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });

  try {
    const { createExactInteractiveReplanSession } = (await server.ssrLoadModule(
      "/benchmarks/evaluator/exact-replan.ts",
    )) as typeof import("./evaluator/exact-replan");
    const { REQUIRED_SENTINELS } = (await server.ssrLoadModule(
      "/benchmarks/scenarios/fixed-grid.ts",
    )) as typeof import("./scenarios/fixed-grid");
    const scenarioId = sentinelOrder[state.sentinelIndex];
    const scenario: SolverScenario | undefined = REQUIRED_SENTINELS.find(
      (candidate) => candidate.id === scenarioId,
    );
    if (!scenario) throw new Error(`Missing required sentinel: ${scenarioId}`);

    const session = createExactInteractiveReplanSession(
      scenario,
      {},
      state.sessionCheckpoint ?? undefined,
    );
    const result = session.advance(Math.min(sliceMs, remainingBudgetMs));
    const report: FeasibilityCompletedReport = {
      status: result.status,
      scenario: result.scenario.id,
      elapsedMs: result.elapsedMs,
      solveCalls: result.solveCalls,
      cachedNodes: result.cachedNodes,
      cachedPolicies: result.cachedPolicies,
      gateEvidence: result.gateEvidence,
      ...(result.status === "completed"
        ? {
            successProbability: result.successProbability,
            expectedConsumption: result.expectedConsumption,
            interactiveF: result.interactiveF,
            manualEntryProbability: result.manualEntryProbability,
            expectedManualEntries: result.expectedManualEntries,
            successAttemptSelectionProbability: result.successAttemptSelectionProbability,
            expectedSuccessAttemptSelections: result.expectedSuccessAttemptSelections,
          }
        : {}),
    };
    console.log(`[A feasibility slice] result ${JSON.stringify(report)}`);

    if (
      result.gateEvidence.internalViolationCount > 0 ||
      result.gateEvidence.boundaryViolationCount > 0
    ) {
      console.error(`[A feasibility slice] probability gate violation in ${scenarioId}`);
      process.exitCode = 1;
    } else if (result.status === "completed") {
      state.completed.push(report);
      state.sentinelIndex += 1;
      state.sessionCheckpoint = null;
    } else {
      state.sessionCheckpoint = session.checkpoint();
    }
    await writeFile(CHECKPOINT_FILE, `${JSON.stringify(state)}\n`, "utf8");
  } finally {
    await server.close();
  }
}
