import { convertState, STRATEGY_PROBABILITY_TOLERANCE, transition } from "../../src/solver/domain";
import { solveWithResearchCostModel } from "../../src/solver/solve";
import type { CollectionState, Kit, Stock } from "../../src/types";
import { availabilityPnormObjective } from "../metrics";
import type { SolverScenario } from "../scenarios/fixed-grid";
import { createGateEvidence, mergeInternalAudit, recordBoundaryGap } from "./exact-replan-gates";
import { consume, stateStockKey, terminalNode } from "./exact-replan-node";
import type {
  ExactEvaluatorOptions,
  ExactInteractiveEvaluation,
  ExactInteractiveReplanCheckpoint,
  ExactInteractiveReplanSession,
  NodeResult,
  PolicyDecision,
} from "./exact-replan-types";

const KITS: Kit[] = ["blue", "purple", "yellow"];

class EvaluationBudgetExceeded extends Error {}

export function createExactInteractiveReplanSession(
  scenario: SolverScenario,
  options: ExactEvaluatorOptions = {},
  checkpoint?: ExactInteractiveReplanCheckpoint,
): ExactInteractiveReplanSession {
  const modelId = options.modelId || "A";
  const costModel = options.costModel || { kind: "availability-pnorm" };
  const boundaryTolerance =
    typeof options.toleranceOverride === "number" &&
    Number.isFinite(options.toleranceOverride) &&
    options.toleranceOverride >= 0
      ? options.toleranceOverride
      : STRATEGY_PROBABILITY_TOLERANCE.supply;
  if (
    checkpoint &&
    (checkpoint.version !== 1 ||
      checkpoint.scenarioId !== scenario.id ||
      checkpoint.modelId !== modelId ||
      JSON.stringify(checkpoint.costModel) !== JSON.stringify(costModel))
  ) {
    throw new Error("Exact interactive-replan checkpoint does not match the requested session.");
  }
  const gateEvidence = checkpoint?.gateEvidence || createGateEvidence();
  const cache = new Map<string, NodeResult>(checkpoint?.cachedNodes || []);
  const policyCache = new Map<string, PolicyDecision>(checkpoint?.cachedPolicies || []);
  let solveCalls = checkpoint?.solveCalls || 0;
  let activeElapsedMs = checkpoint?.activeElapsedMs || 0;
  let sliceStartedAt: number | null = null;
  let deadline = Number.POSITIVE_INFINITY;
  let completedNode: NodeResult | null = checkpoint?.completedNode || null;
  const progressInterval = Math.max(0, Math.trunc(options.progressEverySolveCalls || 0));

  function elapsedMs() {
    const activeSliceMs = sliceStartedAt === null ? 0 : performance.now() - sliceStartedAt;
    return Math.round(activeElapsedMs + activeSliceMs);
  }

  function checkBudget() {
    if (performance.now() >= deadline) throw new EvaluationBudgetExceeded();
  }

  function reportProgress() {
    if (
      !options.onProgress ||
      progressInterval <= 0 ||
      solveCalls === 0 ||
      solveCalls % progressInterval !== 0
    ) {
      return;
    }
    options.onProgress({
      scenarioId: scenario.id,
      modelId,
      elapsedMs: elapsedMs(),
      solveCalls,
      cachedNodes: cache.size,
      cachedPolicies: policyCache.size,
      internalDecisionCount: gateEvidence.internalDecisionCount,
      internalMaxGap: gateEvidence.internalMaxGap,
      internalViolationCount: gateEvidence.internalViolationCount,
      boundaryDecisionCount: gateEvidence.boundaryDecisionCount,
      boundaryMaxGap: gateEvidence.boundaryMaxGap,
      boundaryViolationCount: gateEvidence.boundaryViolationCount,
    });
  }

  function policyFor(state: CollectionState, stock: Stock, key: string) {
    const cachedPolicy = policyCache.get(key);
    if (cachedPolicy) return cachedPolicy;

    const input = { start: state, stock, strategy: "supply" as const };
    const solved = options.policySolver
      ? options.policySolver(input)
      : solveWithResearchCostModel(input, costModel, undefined, {
          ...(options.toleranceOverride !== undefined
            ? { toleranceOverride: options.toleranceOverride }
            : {}),
        });
    solveCalls += 1;
    mergeInternalAudit(gateEvidence, solved.stats?.gateAudit, state, stock);
    const result: PolicyDecision = {
      possible: Boolean(solved.possible),
      best:
        solved.possible && solved.best?.run
          ? {
              firstAction: solved.best.firstAction as Kit,
              run: { count: Math.max(1, Math.trunc(Number(solved.best.run.count) || 1)) },
              probabilityGap: Number(solved.best.probabilityGap || 0),
            }
          : null,
    };
    if (result.possible && result.best) {
      recordBoundaryGap(gateEvidence, state, stock, result.best.probabilityGap, boundaryTolerance);
    }
    policyCache.set(key, result);
    reportProgress();
    checkBudget();
    return result;
  }

  function visit(state: CollectionState, stock: Stock): NodeResult {
    checkBudget();
    if (state.grade === "SR" && state.level >= 15) return terminalNode(1);
    if (state.grade === "R" && state.level >= 15) return visit(convertState(), stock);

    const key = stateStockKey(state, stock);
    const cached = cache.get(key);
    if (cached) return cached;

    const result = policyFor(state, stock, key);
    if (!result.possible || !result.best?.run) {
      const stopped = terminalNode(0);
      cache.set(key, stopped);
      return stopped;
    }

    const best = result.best;
    const kit = best.firstAction as Kit;
    const runCount = Math.max(1, Math.trunc(Number(best.run.count) || 1));
    let failState = state;
    let noSuccessProbability = 1;
    const aggregate = terminalNode(0);

    for (let attempt = 1; attempt <= runCount; attempt += 1) {
      const edge = transition(failState, kit);
      const probability = noSuccessProbability * edge.probability;
      if (probability > 0) {
        const next = visit(edge.success, consume(stock, kit, attempt));
        const manualEntry = runCount > 1 && edge.success.level < 15;
        const successAttemptSelection = runCount > 1 && edge.success.level >= 15;

        aggregate.successProbability += probability * next.successProbability;
        aggregate.manualEntryProbability +=
          probability * (manualEntry ? 1 : next.manualEntryProbability);
        aggregate.expectedManualEntries +=
          probability * ((manualEntry ? 1 : 0) + next.expectedManualEntries);
        aggregate.successAttemptSelectionProbability +=
          probability * (successAttemptSelection ? 1 : next.successAttemptSelectionProbability);
        aggregate.expectedSuccessAttemptSelections +=
          probability * ((successAttemptSelection ? 1 : 0) + next.expectedSuccessAttemptSelections);
        for (const nextKit of KITS) {
          aggregate.expectedConsumption[nextKit] +=
            probability *
            (next.expectedConsumption[nextKit] + (nextKit === kit ? attempt * 10 : 0));
        }
      }

      noSuccessProbability *= 1 - edge.probability;
      failState = edge.fail;
      if (noSuccessProbability === 0) break;
    }

    if (noSuccessProbability > 0) {
      const failedRun = visit(failState, consume(stock, kit, runCount));
      aggregate.successProbability += noSuccessProbability * failedRun.successProbability;
      aggregate.manualEntryProbability += noSuccessProbability * failedRun.manualEntryProbability;
      aggregate.expectedManualEntries += noSuccessProbability * failedRun.expectedManualEntries;
      aggregate.successAttemptSelectionProbability +=
        noSuccessProbability * failedRun.successAttemptSelectionProbability;
      aggregate.expectedSuccessAttemptSelections +=
        noSuccessProbability * failedRun.expectedSuccessAttemptSelections;
      for (const nextKit of KITS) {
        aggregate.expectedConsumption[nextKit] +=
          noSuccessProbability *
          (failedRun.expectedConsumption[nextKit] + (nextKit === kit ? runCount * 10 : 0));
      }
    }

    cache.set(key, aggregate);
    return aggregate;
  }

  function completedResult(result: NodeResult): ExactInteractiveEvaluation {
    return {
      status: "completed",
      scenario,
      modelId,
      elapsedMs: elapsedMs(),
      solveCalls,
      cachedNodes: cache.size,
      cachedPolicies: policyCache.size,
      gateEvidence,
      ...result,
      interactiveF: availabilityPnormObjective(result.expectedConsumption, scenario.stock),
    };
  }

  function incompleteResult(): ExactInteractiveEvaluation {
    return {
      status: "verification_incomplete",
      reason: "time_budget_exceeded",
      scenario,
      modelId,
      elapsedMs: elapsedMs(),
      solveCalls,
      cachedNodes: cache.size,
      cachedPolicies: policyCache.size,
      gateEvidence,
    };
  }

  return {
    advance(timeBudgetMs = options.timeBudgetMs ?? 60_000) {
      if (completedNode) return completedResult(completedNode);
      const sliceBudgetMs = Math.max(0, Number(timeBudgetMs) || 0);
      sliceStartedAt = performance.now();
      deadline = sliceStartedAt + sliceBudgetMs;
      let incomplete = false;
      try {
        completedNode = visit(scenario.start, scenario.stock);
      } catch (error) {
        if (!(error instanceof EvaluationBudgetExceeded)) throw error;
        incomplete = true;
      } finally {
        activeElapsedMs += performance.now() - sliceStartedAt;
        sliceStartedAt = null;
        deadline = Number.POSITIVE_INFINITY;
      }
      if (incomplete || !completedNode) return incompleteResult();
      return completedResult(completedNode);
    },
    checkpoint() {
      return {
        version: 1,
        scenarioId: scenario.id,
        modelId,
        costModel,
        activeElapsedMs,
        solveCalls,
        gateEvidence,
        cachedNodes: Array.from(cache.entries()),
        cachedPolicies: Array.from(policyCache.entries()),
        completedNode,
      };
    },
  };
}

export function evaluateExactInteractiveReplan(
  scenario: SolverScenario,
  options: ExactEvaluatorOptions = {},
): ExactInteractiveEvaluation {
  return createExactInteractiveReplanSession(scenario, options).advance(options.timeBudgetMs);
}
