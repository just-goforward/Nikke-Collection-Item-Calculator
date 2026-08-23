import type { SolverInput, Stock } from "../src/types";
import { rustCoreExportsFromInstance } from "../src/wasm/rustLoader";
import { createRustMinEfSolver } from "../src/wasm/rustMinEfCore";
import { createRustPhase2Solver } from "../src/wasm/rustPhase2Core";
import { normalizeRustProductInput } from "../src/wasm/rustProductInput";
import { buildRecommendedRunForKit } from "../src/wasm/rustProductView";
import {
  RUST_STATUS_BUDGET_EXCEEDED,
  RUST_STATUS_MEMO_FULL,
  RustSolveError,
} from "../src/wasm/rustStatus";
import type {
  RustMinEfPolicyHandle,
  RustPhase2Policy,
  RustPhase2Root,
  SupplyForecastContext,
} from "../src/wasm/rustTypes";
import type {
  ExactInteractiveEvaluation,
  ExactPolicySolverResult,
} from "./evaluator/exact-replan-types";
import { availabilityPnormObjective, maxSupplyDebtDays } from "./metrics";
import type {
  HpCandidate,
  HpRootMetrics,
  HpRootScreenRecord,
  HpSolveOutcome,
} from "./min-ef-hp-model";
import { hpNormPowerValue } from "./min-ef-hp-model";

type PolicyHandle = RustMinEfPolicyHandle | RustPhase2Policy;
type PolicyRoot = RustMinEfPolicyHandle["root"] | RustPhase2Root;

export type HpLadderTrace = {
  minEfOutcome: HpSolveOutcome;
  phase2Outcome: HpSolveOutcome | "not_run";
  selectedBackend: "rust-min-ef" | "rust-phase2" | null;
};

export type HpLadderSession = {
  policySolver: (input: SolverInput) => ExactPolicySolverResult;
  screenRoot: (input: SolverInput, scenarioId: string) => HpRootScreenRecord;
  release: () => void;
  traces: () => readonly HpLadderTrace[];
};

export function createHpLadderSession(
  minEfInstance: WebAssembly.Instance,
  phase2Instance: WebAssembly.Instance,
  candidate: HpCandidate,
  supplyForecast?: SupplyForecastContext,
): HpLadderSession {
  const minEf = createRustMinEfSolver(rustCoreExportsFromInstance(minEfInstance));
  const phase2 = createRustPhase2Solver(rustCoreExportsFromInstance(phase2Instance));
  if (supplyForecast) {
    minEf.setSupplyForecast(supplyForecast);
    phase2.setSupplyForecast(supplyForecast);
  }
  minEf.configureMemoTier(21);
  phase2.configureMemoTier(22);
  const traces: HpLadderTrace[] = [];

  function attempt(input: SolverInput): {
    trace: HpLadderTrace;
    policy: PolicyHandle | null;
    root: PolicyRoot | null;
    optimizerExpectedCost: number | null;
    errorMessage: string | null;
  } {
    const normalized = normalizeRustProductInput(input);
    const normPower = hpNormPowerValue(candidate.normPower);
    try {
      const policy = minEf.solveRootWithCandidates(
        normalized.start,
        normalized.stock,
        candidate.horizonFactor,
        normPower,
        candidate.tolerance,
      );
      const trace: HpLadderTrace = {
        minEfOutcome: "completed",
        phase2Outcome: "not_run",
        selectedBackend: "rust-min-ef",
      };
      traces.push(trace);
      return {
        trace,
        policy,
        root: policy.root,
        optimizerExpectedCost: policy.root.expectedCost,
        errorMessage: null,
      };
    } catch (error) {
      const minEfOutcome = classifySolveError(error);
      if (minEfOutcome !== "memo_full" && minEfOutcome !== "budget_exceeded") {
        const trace: HpLadderTrace = {
          minEfOutcome,
          phase2Outcome: "not_run",
          selectedBackend: null,
        };
        traces.push(trace);
        return {
          trace,
          policy: null,
          root: null,
          optimizerExpectedCost: null,
          errorMessage: errorMessage(error),
        };
      }
      try {
        const policy = phase2.buildPolicy(
          normalized.start,
          normalized.stock,
          candidate.horizonFactor,
          normPower,
          candidate.tolerance,
        );
        const trace: HpLadderTrace = {
          minEfOutcome,
          phase2Outcome: "completed",
          selectedBackend: "rust-phase2",
        };
        traces.push(trace);
        return {
          trace,
          policy,
          root: policy.root,
          optimizerExpectedCost:
            policy.candidates.find(
              (candidateEntry) => candidateEntry.firstAction === policy.root.firstAction,
            )?.resourceCost ?? null,
          errorMessage: null,
        };
      } catch (phase2Error) {
        const trace: HpLadderTrace = {
          minEfOutcome,
          phase2Outcome: classifySolveError(phase2Error),
          selectedBackend: null,
        };
        traces.push(trace);
        return {
          trace,
          policy: null,
          root: null,
          optimizerExpectedCost: null,
          errorMessage: errorMessage(phase2Error),
        };
      }
    }
  }

  function policySolver(input: SolverInput): ExactPolicySolverResult {
    const result = attempt(input);
    if (!result.policy || !result.root) {
      throw new Error(result.errorMessage ?? "H/p Rust ladder failed without an error message.");
    }
    return decisionFromPolicy(input, result.policy, result.root);
  }

  function screenRoot(input: SolverInput, scenarioId: string): HpRootScreenRecord {
    const startedAt = performance.now();
    const result = attempt(input);
    return {
      candidateId: candidate.id,
      scenarioId,
      minEfOutcome: result.trace.minEfOutcome,
      phase2Outcome: result.trace.phase2Outcome,
      selectedBackend: result.trace.selectedBackend,
      metrics:
        result.root === null
          ? null
          : rootMetrics(result.root, input.stock, result.optimizerExpectedCost),
      errorMessage: result.errorMessage,
      elapsedMs: performance.now() - startedAt,
    };
  }

  return {
    policySolver,
    screenRoot,
    release() {
      minEf.releaseMemo();
      phase2.releaseMemo();
    },
    traces: () => traces,
  };
}

export function totalExpectedUses(
  evaluation: Extract<ExactInteractiveEvaluation, { status: "completed" }>,
): number {
  return stockTotal(evaluation.expectedConsumption) / 10;
}

function decisionFromPolicy(
  input: SolverInput,
  policy: PolicyHandle,
  root: PolicyRoot,
): ExactPolicySolverResult {
  if (!root.firstAction) return { possible: false, best: null };
  const normalized = normalizeRustProductInput(input);
  const run = buildRecommendedRunForKit(
    normalized,
    (state, stockUses) => policy.actionAt(state, stockUses),
    root.firstAction,
  );
  if (!run) return { possible: false, best: null };
  return {
    possible: true,
    best: {
      firstAction: root.firstAction,
      run: { count: run.count },
      probabilityGap: Math.max(0, root.maxSuccessProbability - root.successProbability),
    },
  };
}

function rootMetrics(
  root: PolicyRoot,
  stock: Stock,
  optimizerExpectedCost: number | null,
): HpRootMetrics {
  return {
    firstAction: root.firstAction,
    successProbability: root.successProbability,
    maxSuccessProbability: root.maxSuccessProbability,
    expectedConsumption: { ...root.vector },
    totalExpectedUses: stockTotal(root.vector) / 10,
    referenceInteractiveF: availabilityPnormObjective(root.vector, stock),
    maxSupplyDebtDays: maxSupplyDebtDays(root.vector),
    optimizerExpectedCost,
    nodeCount: root.states,
  };
}

function stockTotal(stock: Stock): number {
  return stock.blue + stock.purple + stock.yellow;
}

function classifySolveError(error: unknown): HpSolveOutcome {
  if (error instanceof RustSolveError) {
    if (error.status === RUST_STATUS_MEMO_FULL) return "memo_full";
    if (error.status === RUST_STATUS_BUDGET_EXCEEDED) return "budget_exceeded";
  }
  return "failure";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
