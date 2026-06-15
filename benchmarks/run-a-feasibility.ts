import { createServer } from "vite";
import type { ExactEvaluationProgress } from "./evaluator/exact-replan-types";
import { envValue, parsePositiveInteger } from "./runner-utils";
import type { SolverScenario } from "./scenarios/fixed-grid";

const DEFAULT_TOTAL_BUDGET_MS = 60 * 60 * 1000;
const totalBudgetMs = parsePositiveInteger(
  envValue("A_FEASIBILITY_BUDGET_MS"),
  DEFAULT_TOTAL_BUDGET_MS,
);
const progressEverySolveCalls = parsePositiveInteger(
  envValue("A_FEASIBILITY_PROGRESS_CALLS"),
  1000,
);

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const { evaluateExactInteractiveReplan } = (await server.ssrLoadModule(
    "/benchmarks/evaluator/exact-replan.ts",
  )) as typeof import("./evaluator/exact-replan");
  const { REQUIRED_SENTINELS } = (await server.ssrLoadModule(
    "/benchmarks/scenarios/fixed-grid.ts",
  )) as typeof import("./scenarios/fixed-grid");
  const sentinelOrder = [
    "R0-balanced300",
    "SR0-balanced300",
    "R0-balanced100",
    "SR0-balanced100",
    "R14e900-yellow30",
  ];
  const sentinels = sentinelOrder.map((id) => {
    const scenario: SolverScenario | undefined = REQUIRED_SENTINELS.find(
      (candidate) => candidate.id === id,
    );
    if (!scenario) throw new Error(`Missing required sentinel: ${id}`);
    return scenario;
  });
  const startedAt = performance.now();

  console.log(
    `[A feasibility] totalBudgetMs=${totalBudgetMs} progressEverySolveCalls=${progressEverySolveCalls}`,
  );

  for (const scenario of sentinels) {
    const remainingBudget = totalBudgetMs - (performance.now() - startedAt);
    if (remainingBudget <= 0) {
      console.error(`[A feasibility] budget exhausted before ${scenario.id}`);
      process.exitCode = 1;
      break;
    }

    console.log(`[A feasibility] starting ${scenario.id}`);
    const result = evaluateExactInteractiveReplan(scenario, {
      timeBudgetMs: remainingBudget,
      progressEverySolveCalls,
      onProgress: (progress: ExactEvaluationProgress) => {
        console.log(`[A feasibility] progress ${JSON.stringify(progress)}`);
      },
    });
    console.log(`[A feasibility] result ${JSON.stringify(result)}`);

    if (result.status !== "completed") {
      process.exitCode = 1;
      break;
    }
    if (
      result.gateEvidence.internalViolationCount > 0 ||
      result.gateEvidence.boundaryViolationCount > 0
    ) {
      console.error(`[A feasibility] probability gate violation in ${scenario.id}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await server.close();
}
