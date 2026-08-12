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
import type {
  RustCoreExports,
  RustMinEfPolicyHandle,
  RustPhase2Policy,
} from "../src/wasm/rustTypes";
import type { ExactPolicySolverResult } from "./evaluator/exact-replan-types";
import {
  conditionalExactRescueEligible,
  SOLVER_PORTFOLIO_ROUTING_CONTRACT,
} from "./solver-portfolio-routing-contract";
import type { PortfolioOutcome, PortfolioSemantic } from "./solver-portfolio-study";

export type SolverPortfolioRouteMode =
  | "baseline"
  | "branch-bound-b2-on-capacity"
  | "conditional-min-ef-tier22"
  | "direct-conditional-min-ef-tier22";

type SelectedBackend = "branch-bound-b2" | "min-ef-tier21" | "min-ef-tier22" | "phase2";

export type SolverPortfolioRouteTrace = {
  eligibilityMatched: boolean;
  minEfTier21: {
    elapsedMs: number;
    nodeCount: number | null;
    outcome: PortfolioOutcome | "not_run";
  };
  rescue: {
    arm: "branch-bound-b2-tier22" | "min-ef-tier22" | "not_run";
    elapsedMs: number;
    nodeCount: number | null;
    outcome: PortfolioOutcome | "not_run";
    prepassMismatches: number | null;
  };
  phase2: {
    elapsedMs: number;
    nodeCount: number | null;
    outcome: PortfolioOutcome | "not_run";
  };
  selectedBackend: SelectedBackend | null;
  semantic: PortfolioSemantic | null;
  totalElapsedMs: number;
};

export type SolverPortfolioLadderSession = {
  policySolver: (input: SolverInput) => ExactPolicySolverResult;
  release: () => void;
  solve: (input: SolverInput) => {
    decision: ExactPolicySolverResult;
    trace: SolverPortfolioRouteTrace;
  };
  traces: () => readonly SolverPortfolioRouteTrace[];
};

export function createSolverPortfolioLadderSession(
  mode: SolverPortfolioRouteMode,
  instances: {
    minEfTier21: WebAssembly.Instance;
    phase2: WebAssembly.Instance;
    rescue?: WebAssembly.Instance;
  },
): SolverPortfolioLadderSession {
  const primaryExports = rustCoreExportsFromInstance(instances.minEfTier21);
  const phase2Exports = rustCoreExportsFromInstance(instances.phase2);
  const rescueExports = instances.rescue ? rustCoreExportsFromInstance(instances.rescue) : null;
  const primary = createRustMinEfSolver(primaryExports);
  const phase2 = createRustPhase2Solver(phase2Exports);
  const rescue = rescueExports ? createRustMinEfSolver(rescueExports) : null;
  const traces: SolverPortfolioRouteTrace[] = [];

  primary.configureMemoTier(SOLVER_PORTFOLIO_ROUTING_CONTRACT.minEfTier);
  phase2.configureMemoTier(SOLVER_PORTFOLIO_ROUTING_CONTRACT.phase2Tier);
  if (mode !== "baseline" && !rescue) throw new Error(`${mode} requires a rescue WASM instance.`);
  if (rescue) {
    rescue.configureMemoTier(SOLVER_PORTFOLIO_ROUTING_CONTRACT.rescueTier);
    rescueExports?.configureNodeBudget?.(SOLVER_PORTFOLIO_ROUTING_CONTRACT.rescueNodeBudget);
  }
  const branchBoundExports =
    mode === "branch-bound-b2-on-capacity" ? configureBranchBound(rescueExports) : null;

  function solve(input: SolverInput) {
    const normalized = normalizeRustProductInput(input);
    const conditionalRuleMatched = conditionalExactRescueEligible(normalized);
    const eligibilityMatched =
      mode === "branch-bound-b2-on-capacity" ||
      ((mode === "conditional-min-ef-tier22" || mode === "direct-conditional-min-ef-tier22") &&
        conditionalRuleMatched);
    const directlyUseRescue = mode === "direct-conditional-min-ef-tier22" && eligibilityMatched;
    const trace = emptyTrace(eligibilityMatched);

    if (!directlyUseRescue) {
      primaryExports.configureNodeBudget?.(SOLVER_PORTFOLIO_ROUTING_CONTRACT.minEfNodeBudget);
      const primaryStartedAt = performance.now();
      try {
        const policy = primary.solveRootWithCandidates(
          normalized.start,
          normalized.stock,
          SOLVER_PORTFOLIO_ROUTING_CONTRACT.horizonFactor,
          SOLVER_PORTFOLIO_ROUTING_CONTRACT.normPower,
          SOLVER_PORTFOLIO_ROUTING_CONTRACT.tolerance,
        );
        trace.minEfTier21 = {
          elapsedMs: performance.now() - primaryStartedAt,
          nodeCount: policy.nodeCount,
          outcome: "completed",
        };
        return finish(input, trace, policy, "min-ef-tier21");
      } catch (error) {
        trace.minEfTier21 = {
          elapsedMs: performance.now() - primaryStartedAt,
          nodeCount: nodeCount(primaryExports),
          outcome: classifySolveError(error),
        };
        if (!isCapacityFailure(trace.minEfTier21.outcome)) throw error;
      }
    }

    if (eligibilityMatched && rescue && rescueExports) {
      const rescueStartedAt = performance.now();
      trace.rescue.arm =
        mode === "branch-bound-b2-on-capacity" ? "branch-bound-b2-tier22" : "min-ef-tier22";
      try {
        const policy = rescue.solveRootWithCandidates(
          normalized.start,
          normalized.stock,
          SOLVER_PORTFOLIO_ROUTING_CONTRACT.horizonFactor,
          SOLVER_PORTFOLIO_ROUTING_CONTRACT.normPower,
          SOLVER_PORTFOLIO_ROUTING_CONTRACT.tolerance,
        );
        trace.rescue = {
          ...trace.rescue,
          elapsedMs: performance.now() - rescueStartedAt,
          nodeCount: policy.nodeCount,
          outcome: "completed",
          prepassMismatches: branchBoundExports
            ? branchBoundExports.minEfBranchBoundPrepassMismatches()
            : null,
        };
        return finish(
          input,
          trace,
          policy,
          mode === "branch-bound-b2-on-capacity" ? "branch-bound-b2" : "min-ef-tier22",
        );
      } catch (error) {
        trace.rescue = {
          ...trace.rescue,
          elapsedMs: performance.now() - rescueStartedAt,
          nodeCount: nodeCount(rescueExports),
          outcome: classifySolveError(error),
          prepassMismatches: null,
        };
        if (!isCapacityFailure(trace.rescue.outcome)) throw error;
      }
    }

    const phase2StartedAt = performance.now();
    try {
      const policy = phase2.buildPolicy(
        normalized.start,
        normalized.stock,
        SOLVER_PORTFOLIO_ROUTING_CONTRACT.horizonFactor,
        SOLVER_PORTFOLIO_ROUTING_CONTRACT.normPower,
        SOLVER_PORTFOLIO_ROUTING_CONTRACT.tolerance,
      );
      trace.phase2 = {
        elapsedMs: performance.now() - phase2StartedAt,
        nodeCount: policy.root.states,
        outcome: "completed",
      };
      return finish(input, trace, policy, "phase2");
    } catch (error) {
      trace.phase2 = {
        elapsedMs: performance.now() - phase2StartedAt,
        nodeCount: nodeCount(phase2Exports),
        outcome: classifySolveError(error),
      };
      trace.totalElapsedMs = sumElapsed(trace);
      traces.push(trace);
      throw error;
    }
  }

  function finish(
    input: SolverInput,
    trace: SolverPortfolioRouteTrace,
    policy: RustMinEfPolicyHandle | RustPhase2Policy,
    selectedBackend: SelectedBackend,
  ) {
    trace.selectedBackend = selectedBackend;
    trace.semantic = semanticFromPolicy(policy);
    trace.totalElapsedMs = sumElapsed(trace);
    const decision = decisionFromPolicy(input, policy);
    traces.push(trace);
    return { decision, trace };
  }

  return {
    policySolver(input) {
      return solve(input).decision;
    },
    release() {
      primary.releaseMemo();
      rescue?.releaseMemo();
      phase2.releaseMemo();
    },
    solve,
    traces: () => traces,
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

function semanticFromPolicy(policy: RustMinEfPolicyHandle | RustPhase2Policy): PortfolioSemantic {
  const root = policy.root;
  const expectedCost =
    "expectedCost" in root
      ? root.expectedCost
      : ((policy as RustPhase2Policy).candidates.find(
          (candidate) => candidate.firstAction === root.firstAction,
        )?.resourceCost ?? null);
  return {
    action: root.firstAction,
    expectedCost,
    maxSuccessProbability: root.maxSuccessProbability,
    successProbability: root.successProbability,
    vector: { ...root.vector },
  };
}

type BranchBoundResearchFunctions = {
  configureMinEfBranchBoundPruning: (mode: number) => number;
  configureMinEfBranchBoundSuccessMemo: (tier: number) => void;
  minEfBranchBoundPrepassMismatches: () => number;
};

type BranchBoundResearchExports = RustCoreExports & BranchBoundResearchFunctions;

function configureBranchBound(exports: RustCoreExports | null): BranchBoundResearchExports {
  if (!exports) throw new Error("Missing branch-bound research exports.");
  const research = exports as RustCoreExports & Partial<BranchBoundResearchFunctions>;
  if (
    typeof research.configureMinEfBranchBoundPruning !== "function" ||
    typeof research.configureMinEfBranchBoundSuccessMemo !== "function" ||
    typeof research.minEfBranchBoundPrepassMismatches !== "function"
  ) {
    throw new Error("Missing branch-bound research exports.");
  }
  const branchBound = research as BranchBoundResearchExports;
  branchBound.configureMinEfBranchBoundSuccessMemo(SOLVER_PORTFOLIO_ROUTING_CONTRACT.rescueTier);
  if (
    branchBound.configureMinEfBranchBoundPruning(
      SOLVER_PORTFOLIO_ROUTING_CONTRACT.branchBoundMode,
    ) !== 1
  ) {
    throw new Error("Branch-bound candidate rejected B2 mode.");
  }
  return branchBound;
}

function emptyTrace(eligibilityMatched: boolean): SolverPortfolioRouteTrace {
  return {
    eligibilityMatched,
    minEfTier21: { elapsedMs: 0, nodeCount: null, outcome: "not_run" },
    rescue: {
      arm: "not_run",
      elapsedMs: 0,
      nodeCount: null,
      outcome: "not_run",
      prepassMismatches: null,
    },
    phase2: { elapsedMs: 0, nodeCount: null, outcome: "not_run" },
    selectedBackend: null,
    semantic: null,
    totalElapsedMs: 0,
  };
}

function sumElapsed(trace: SolverPortfolioRouteTrace) {
  return trace.minEfTier21.elapsedMs + trace.rescue.elapsedMs + trace.phase2.elapsedMs;
}

function classifySolveError(error: unknown): PortfolioOutcome {
  if (error instanceof RustSolveError) {
    if (error.status === RUST_STATUS_MEMO_FULL) return "memo_full";
    if (error.status === RUST_STATUS_BUDGET_EXCEEDED) return "budget_exceeded";
  }
  return "failure";
}

function isCapacityFailure(outcome: PortfolioOutcome | "not_run") {
  return outcome === "memo_full" || outcome === "budget_exceeded";
}

function nodeCount(exports: RustCoreExports) {
  const minEfNodes = exports.minEfNodeCount?.();
  if (typeof minEfNodes === "number" && Number.isFinite(minEfNodes)) return minEfNodes;
  const phase2Nodes = exports.statesCount?.();
  return typeof phase2Nodes === "number" && Number.isFinite(phase2Nodes) ? phase2Nodes : null;
}
