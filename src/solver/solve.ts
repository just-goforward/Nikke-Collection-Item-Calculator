import type { KitVector, ProgressCallback, ResearchCostModel } from "./domain";
import {
  convertState,
  DEFAULT_RESEARCH_COST_MODEL,
  isConvertStateNormalized,
  isTerminalNormalized,
  KIT_ORDER,
  round,
  SUPPLY_AVAILABILITY_PARAMS,
} from "./domain";
import { compareByStrategy, probabilityToleranceForStrategy } from "./gate";
import {
  type NormalizedSolverInput,
  normalizeSolverInput,
  type RawSolverInput,
  readMonteCarloRuns,
  readMonteCarloSeed,
} from "./input";
import { type ActionValue, finiteInventoryMdp, type SolveExecutionOptions } from "./mdp";
import type { ResearchSolverResult, SolverResult, SolverTopCandidate } from "./result-types";
import { buildFailureRoute, buildRecommendedRun, buildRecommendedRunForKit } from "./routes";
import { simulate } from "./simulation";

type MdpResult = ReturnType<typeof finiteInventoryMdp>;

function zeroVector(): KitVector {
  return { blue: 0, purple: 0, yellow: 0 };
}

function terminalOrConvertResult(input: NormalizedSolverInput): SolverResult | null {
  if (isTerminalNormalized(input.start)) {
    return { terminal: true, input, message: "이미 SR 15레벨입니다." };
  }
  if (!isConvertStateNormalized(input.start)) return null;
  return {
    possible: true,
    convertOnly: true,
    input,
    best: {
      name: "등급 전환",
      firstAction: "convert",
      firstProbability: 1,
      success: convertState(),
      fail: convertState(),
      vector: zeroVector(),
      totalKits: 0,
      successProbability: 1,
      maxSuccessProbability: 1,
      probabilityGap: 0,
      pressure: 0,
      supplyCost: 0,
      availabilityCost: 0,
      legacySupplyCost: 0,
      resourceCost: 0,
    },
    route: [],
    monteCarlo: { runs: 0, completed: 0, successProbability: 1, vector: zeroVector() },
    stats: { states: 0, exact: true, tolerance: 0, iterations: 0 },
    topCandidates: [],
  };
}

function impossibleResult(input: NormalizedSolverInput, message: string): SolverResult {
  return { possible: false, input, message };
}

function rankedRootActions(
  input: NormalizedSolverInput,
  mdp: MdpResult,
  probabilityTolerance: number,
) {
  return KIT_ORDER.map((kit) => mdp.valueForAction(input.start, input.stockUses, kit))
    .filter((candidate): candidate is ActionValue => Boolean(candidate))
    .sort((a, b) =>
      compareByStrategy(a, b, mdp.maxSuccessProbability, input.strategy, probabilityTolerance),
    );
}

function topCandidate(
  input: NormalizedSolverInput,
  mdp: MdpResult,
  candidate: ActionValue,
): SolverTopCandidate {
  const run = buildRecommendedRunForKit(input, mdp.actionFor, candidate.firstAction);
  if (!run) throw new Error("Expected a recommended run for a feasible root candidate.");
  return {
    name: candidate.name,
    firstAction: candidate.firstAction,
    firstProbability: candidate.firstProbability,
    run,
    vector: Object.fromEntries(
      KIT_ORDER.map((kit) => [kit, round(candidate.vector[kit], 4)]),
    ) as KitVector,
    totalKits: round(candidate.totalKits, 4),
    successProbability: round(candidate.successProbability, 8),
    probabilityGap: round(candidate.probabilityGap, 8),
    pressure: round(candidate.pressure, 8),
    supplyCost: round(candidate.supplyCost, 8),
    availabilityCost: round(candidate.availabilityCost, 8),
    legacySupplyCost: round(candidate.legacySupplyCost, 8),
    resourceCost: round(candidate.resourceCost, 8),
  };
}

function successfulResult({
  actionValues,
  best,
  input,
  mdp,
  monteCarloRuns,
  monteCarloSeed,
  probabilityTolerance,
}: {
  actionValues: ActionValue[];
  best: ActionValue;
  input: NormalizedSolverInput;
  mdp: MdpResult;
  monteCarloRuns: number;
  monteCarloSeed: number;
  probabilityTolerance: number;
}): SolverResult {
  const run = buildRecommendedRun(input, mdp.actionFor);
  const route = buildFailureRoute(input, mdp.actionFor);
  const monteCarlo =
    monteCarloRuns > 0
      ? simulate(input, mdp.actionFor, monteCarloRuns, monteCarloSeed)
      : {
          runs: 0,
          completed: 0,
          successProbability: best.successProbability,
          vector: zeroVector(),
        };
  return {
    possible: true,
    terminal: false,
    input,
    candidateCount: actionValues.length,
    best: {
      name: "보유량 유한 MDP",
      firstAction: best.firstAction,
      firstProbability: best.firstProbability,
      run,
      success: best.success,
      fail: best.fail,
      vector: best.vector,
      totalKits: best.totalKits,
      successProbability: best.successProbability,
      maxSuccessProbability: best.maxSuccessProbability,
      probabilityGap: best.probabilityGap,
      pressure: best.pressure,
      supplyCost: best.supplyCost,
      availabilityCost: best.availabilityCost,
      legacySupplyCost: best.legacySupplyCost,
      resourceCost: best.resourceCost,
    },
    route,
    monteCarlo,
    stats: {
      states: mdp.states,
      exact: true,
      tolerance: 0,
      probabilityTolerance,
      maxSuccessProbability: mdp.maxSuccessProbability,
      dynamicCapReductions: mdp.dynamicCapReductions,
      dynamicCapFallbacks: mdp.dynamicCapFallbacks,
      ...(mdp.gateAudit ? { gateAudit: mdp.gateAudit } : {}),
      strategy: input.strategy,
      supplyAvailability: SUPPLY_AVAILABILITY_PARAMS,
      iterations: 0,
    },
    topCandidates: actionValues.map((candidate) => topCandidate(input, mdp, candidate)),
  };
}

function solveInternal(
  rawInput: RawSolverInput,
  progress?: ProgressCallback,
  options: SolveExecutionOptions = {},
): SolverResult {
  const input = normalizeSolverInput(rawInput);
  const probabilityTolerance = probabilityToleranceForStrategy(
    input.strategy,
    options.toleranceOverride,
  );
  const monteCarloRuns = readMonteCarloRuns(rawInput);
  const monteCarloSeed = readMonteCarloSeed(rawInput);
  if (progress) progress({ phase: "build", scanned: 0, total: 1 });
  const earlyResult = terminalOrConvertResult(input);
  if (earlyResult) return earlyResult;

  const totalUses = input.stockUses.blue + input.stockUses.purple + input.stockUses.yellow;
  if (totalUses <= 0) {
    return impossibleResult(
      input,
      "사용 가능한 키트가 없습니다. 각 키트는 10개 단위로만 사용할 수 있습니다.",
    );
  }

  const mdp = finiteInventoryMdp(input, progress, options);
  if (!mdp.firstAction) {
    return impossibleResult(input, "현재 보유 키트로 가능한 행동이 없습니다.");
  }
  const actionValues = rankedRootActions(input, mdp, probabilityTolerance);
  const best =
    actionValues.find((candidate) => candidate.firstAction === mdp.firstAction) ?? actionValues[0];
  if (!best) return impossibleResult(input, "현재 보유 키트로 가능한 행동이 없습니다.");

  const result = successfulResult({
    actionValues,
    best,
    input,
    mdp,
    monteCarloRuns,
    monteCarloSeed,
    probabilityTolerance,
  });
  if (progress) progress({ phase: "done", scanned: 1, total: 1 });
  return result;
}

function solve(input: RawSolverInput, progress?: ProgressCallback): SolverResult {
  return solveInternal(input, progress);
}

function solveWithResearchCostModel(
  input: RawSolverInput,
  model: ResearchCostModel = DEFAULT_RESEARCH_COST_MODEL,
  progress?: ProgressCallback,
  options: Omit<SolveExecutionOptions, "researchCostModel"> = {},
): ResearchSolverResult {
  return solveInternal(input, progress, {
    researchCostModel: model,
    collectGateAudit: options.collectGateAudit ?? true,
    ...(options.toleranceOverride !== undefined
      ? { toleranceOverride: options.toleranceOverride }
      : {}),
  }) as ResearchSolverResult;
}

export { solve, solveWithResearchCostModel };
