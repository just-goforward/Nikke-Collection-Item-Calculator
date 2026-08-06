import {
  convertState,
  EXPECTED_28_DAY_GAIN,
  type ResearchCostModel,
  transition,
} from "../../src/solver/domain";
import { solveWithResearchCostModel } from "../../src/solver/solve";
import type { CollectionState, Kit, SolverInput, Stock } from "../../src/types";
import type { SolverScenario } from "../scenarios/fixed-grid";
import type { ExactPolicySolverResult } from "./exact-replan-types";

const KITS: Kit[] = ["blue", "purple", "yellow"];

type TrajectoryOptions = {
  modelId?: string;
  costModel?: ResearchCostModel;
  policySolver?: (input: SolverInput) => ExactPolicySolverResult;
  toleranceOverride?: number;
  runs?: number;
  seed?: number;
  stepLimit?: number;
  timeBudgetMs?: number;
};

export type TrajectorySample = {
  completed: boolean;
  termination: "completed" | "depleted" | "step_guard_exceeded";
  consumption: Stock;
  remainingStock: Stock;
  minAutonomyDays: number;
  anyKitDepleted: boolean;
  manualEntryExposed: boolean;
  manualEntries: number;
  successAttemptSelectionExposed: boolean;
  successAttemptSelections: number;
};

export type TrajectoryEvaluation =
  | {
      status: "completed";
      scenario: SolverScenario;
      modelId: string;
      runs: number;
      seed: number;
      elapsedMs: number;
      solveCalls: number;
      cachedPolicies: number;
      samples: TrajectorySample[];
    }
  | {
      status: "verification_incomplete";
      reason: "time_budget_exceeded";
      scenario: SolverScenario;
      modelId: string;
      runsCompleted: number;
      seed: number;
      elapsedMs: number;
      solveCalls: number;
      cachedPolicies: number;
    };

class TrajectoryBudgetExceeded extends Error {}

function makeRandom(seed: number) {
  let value = seed >>> 0;
  return function random() {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function policyKey(state: CollectionState, stock: Stock) {
  return `${state.grade}:${state.level}:${state.exp}|${stock.blue}:${stock.purple}:${stock.yellow}`;
}

function consume(stock: Stock, kit: Kit, attempts: number): Stock {
  return {
    ...stock,
    [kit]: Math.max(0, stock[kit] - attempts * 10),
  };
}

function consumed(initialStock: Stock, remainingStock: Stock): Stock {
  return {
    blue: initialStock.blue - remainingStock.blue,
    purple: initialStock.purple - remainingStock.purple,
    yellow: initialStock.yellow - remainingStock.yellow,
  };
}

function minAutonomyDays(stock: Stock) {
  return Math.min(...KITS.map((kit) => stock[kit] / (EXPECTED_28_DAY_GAIN[kit] / 28)));
}

export function collectInteractiveTrajectories(
  scenario: SolverScenario,
  options: TrajectoryOptions = {},
): TrajectoryEvaluation {
  const modelId = options.modelId || "A";
  const costModel = options.costModel || { kind: "availability-pnorm" };
  const runs = Math.max(0, Math.trunc(options.runs ?? 12_000));
  const seed = Math.max(0, Math.trunc(options.seed ?? 20260505));
  const stepLimit = Math.max(1, Math.trunc(options.stepLimit ?? 1000));
  const startedAt = performance.now();
  const deadline = startedAt + (options.timeBudgetMs ?? Number.POSITIVE_INFINITY);
  const random = makeRandom(seed);
  const policyCache = new Map<string, ExactPolicySolverResult>();
  const samples: TrajectorySample[] = [];
  let solveCalls = 0;

  function checkBudget() {
    if (performance.now() >= deadline) throw new TrajectoryBudgetExceeded();
  }

  function policy(state: CollectionState, stock: Stock) {
    const key = policyKey(state, stock);
    const cached = policyCache.get(key);
    if (cached) return cached;
    const input = { start: state, stock, strategy: "supply" as const };
    const result = options.policySolver
      ? options.policySolver(input)
      : solveWithResearchCostModel(input, costModel, undefined, {
          ...(options.toleranceOverride !== undefined
            ? { toleranceOverride: options.toleranceOverride }
            : {}),
        });
    solveCalls += 1;
    checkBudget();
    policyCache.set(key, result);
    return result;
  }

  try {
    for (let run = 0; run < runs; run += 1) {
      checkBudget();
      let state = { ...scenario.start };
      let stock = { ...scenario.stock };
      let manualEntries = 0;
      let successAttemptSelections = 0;
      let termination: TrajectorySample["termination"] = "step_guard_exceeded";

      for (let step = 0; step < stepLimit; step += 1) {
        if (state.grade === "SR" && state.level >= 15) {
          termination = "completed";
          break;
        }
        if (state.grade === "R" && state.level >= 15) {
          state = convertState();
          continue;
        }

        const result = policy(state, stock);
        if (!result.possible || !result.best?.run) {
          termination = "depleted";
          break;
        }

        const kit = result.best.firstAction as Kit;
        const count = Math.max(1, Math.trunc(Number(result.best.run.count) || 1));
        let failedState = state;
        let succeeded = false;

        for (let attempt = 1; attempt <= count; attempt += 1) {
          const edge = transition(failedState, kit);
          if (random() < edge.probability) {
            stock = consume(stock, kit, attempt);
            state = edge.success;
            if (count > 1 && edge.success.level < 15) manualEntries += 1;
            if (count > 1 && edge.success.level >= 15) successAttemptSelections += 1;
            succeeded = true;
            break;
          }
          failedState = edge.fail;
        }

        if (!succeeded) {
          stock = consume(stock, kit, count);
          state = failedState;
        }
      }

      const completion = termination === "completed";
      samples.push({
        completed: completion,
        termination,
        consumption: consumed(scenario.stock, stock),
        remainingStock: stock,
        minAutonomyDays: minAutonomyDays(stock),
        anyKitDepleted: KITS.some((kit) => stock[kit] === 0),
        manualEntryExposed: manualEntries > 0,
        manualEntries,
        successAttemptSelectionExposed: successAttemptSelections > 0,
        successAttemptSelections,
      });
    }

    return {
      status: "completed",
      scenario,
      modelId,
      runs,
      seed,
      elapsedMs: Math.round(performance.now() - startedAt),
      solveCalls,
      cachedPolicies: policyCache.size,
      samples,
    };
  } catch (error) {
    if (!(error instanceof TrajectoryBudgetExceeded)) throw error;
    return {
      status: "verification_incomplete",
      reason: "time_budget_exceeded",
      scenario,
      modelId,
      runsCompleted: samples.length,
      seed,
      elapsedMs: Math.round(performance.now() - startedAt),
      solveCalls,
      cachedPolicies: policyCache.size,
    };
  }
}
