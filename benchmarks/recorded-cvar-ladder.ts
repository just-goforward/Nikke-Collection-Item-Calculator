import type { SolverInput } from "../src/types";
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
import type { RustMinEfPolicyHandle, RustPhase2Policy } from "../src/wasm/rustTypes";
import type { ExactPolicySolverResult } from "./evaluator/exact-replan-types";
import {
  createRecordedCvarPolicySolver,
  RECORDED_CVAR_OPTIONS,
  type RecordedCvarDecision,
} from "./recorded-cvar-policy";

type MinEfOutcome = "completed" | "memo_full" | "budget_exceeded" | "failure";

export type RecordedCvarLadderSummary = {
  calls: number;
  minEfOutcomes: Record<MinEfOutcome, number>;
  cvarAttempts: number;
  cvarFailures: number;
  recordedPolicySelected: number;
  cvarDecisionChanges: number;
  phase2Fallbacks: number;
  firstCvarDecisions: RecordedCvarDecision[];
  firstCvarFailures: string[];
};

export function createRecordedCvarFallbackLadderSession(
  minEfInstance: WebAssembly.Instance,
  cvarInstance: WebAssembly.Instance,
  phase2Instance: WebAssembly.Instance,
) {
  const minEf = createRustMinEfSolver(rustCoreExportsFromInstance(minEfInstance));
  const cvarExports = rustCoreExportsFromInstance(cvarInstance);
  const cvar = createRecordedCvarPolicySolver(cvarExports, RECORDED_CVAR_OPTIONS);
  const phase2 = createRustPhase2Solver(rustCoreExportsFromInstance(phase2Instance));
  minEf.configureMemoTier(21);
  phase2.configureMemoTier(22);
  const summary = emptySummary();

  function policySolver(input: SolverInput): ExactPolicySolverResult {
    summary.calls += 1;
    const normalized = normalizeRustProductInput(input);
    try {
      const policy = minEf.solveRootWithCandidates(normalized.start, normalized.stock, 0.75, 3, 0);
      summary.minEfOutcomes.completed += 1;
      return decisionFromPolicy(input, policy);
    } catch (error) {
      const outcome = classifyMinEfError(error);
      summary.minEfOutcomes[outcome] += 1;
      if (outcome !== "memo_full" && outcome !== "budget_exceeded") throw error;
    }

    summary.cvarAttempts += 1;
    try {
      const result = cvar.solve(input);
      const decision = cvar.decisions.at(-1);
      if (!decision) throw new Error("Recorded CVaR solver returned no decision record.");
      summary.recordedPolicySelected += Number(decision.selectedPolicy === "recorded_cvar");
      summary.cvarDecisionChanges += Number(decision.decisionChanged);
      if (summary.firstCvarDecisions.length < 8) {
        summary.firstCvarDecisions.push(structuredClone(decision));
      }
      return result;
    } catch (error) {
      summary.cvarFailures += 1;
      if (summary.firstCvarFailures.length < 8) {
        summary.firstCvarFailures.push(error instanceof Error ? error.message : String(error));
      }
    }

    summary.phase2Fallbacks += 1;
    const policy = phase2.buildPolicy(normalized.start, normalized.stock, 0.75, 3, 0);
    return decisionFromPolicy(input, policy);
  }

  return {
    policySolver,
    release() {
      minEf.releaseMemo();
      cvarExports.releasePhase2Memo?.();
      phase2.releaseMemo();
    },
    summary: () => structuredClone(summary),
  };
}

function decisionFromPolicy(
  input: SolverInput,
  policy: RustMinEfPolicyHandle | RustPhase2Policy,
): ExactPolicySolverResult {
  const root = policy.root;
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
      probabilityGap: Math.max(0, root.maxSuccessProbability - root.successProbability),
      run: { count: run.count },
    },
  };
}

function classifyMinEfError(error: unknown): MinEfOutcome {
  if (error instanceof RustSolveError) {
    if (error.status === RUST_STATUS_MEMO_FULL) return "memo_full";
    if (error.status === RUST_STATUS_BUDGET_EXCEEDED) return "budget_exceeded";
  }
  return "failure";
}

function emptySummary(): RecordedCvarLadderSummary {
  return {
    calls: 0,
    minEfOutcomes: { completed: 0, memo_full: 0, budget_exceeded: 0, failure: 0 },
    cvarAttempts: 0,
    cvarFailures: 0,
    recordedPolicySelected: 0,
    cvarDecisionChanges: 0,
    phase2Fallbacks: 0,
    firstCvarDecisions: [],
    firstCvarFailures: [],
  };
}
