import type { ResearchCostModel } from "../../src/solver/domain";
import type { ProbabilityGateWitness, solveWithResearchCostModel } from "../../src/solver/solve";
import type { CollectionState, Kit, SolverInput, Stock } from "../../src/types";
import type { SolverScenario } from "../scenarios/fixed-grid";

export type ModelId = string;

export type ExactEvaluatorOptions = {
  modelId?: ModelId;
  costModel?: ResearchCostModel;
  policySolver?: (input: SolverInput) => ReturnType<typeof solveWithResearchCostModel>;
  toleranceOverride?: number;
  timeBudgetMs?: number;
  progressEverySolveCalls?: number;
  onProgress?: (progress: ExactEvaluationProgress) => void;
};

export type BoundaryGateWitness = {
  gap: number;
  state: CollectionState;
  physicalStock: Stock;
};

export type GateEvidence = {
  internalDecisionCount: number;
  internalMaxGap: number;
  internalMaxGapWitness: {
    boundaryState: CollectionState;
    boundaryPhysicalStock: Stock;
    mdpWitness: ProbabilityGateWitness;
  } | null;
  internalViolationCount: number;
  internalFirstViolationWitness: {
    boundaryState: CollectionState;
    boundaryPhysicalStock: Stock;
    mdpWitness: ProbabilityGateWitness;
  } | null;
  internalEligibleEmptyCount: number;
  internalFixedToleranceViolationCount: number;
  internalFirstFixedToleranceViolationWitness: {
    boundaryState: CollectionState;
    boundaryPhysicalStock: Stock;
    mdpWitness: ProbabilityGateWitness;
  } | null;
  boundaryDecisionCount: number;
  boundaryMaxGap: number;
  boundaryMaxGapWitness: BoundaryGateWitness | null;
  boundaryViolationCount: number;
  boundaryFirstViolationWitness: BoundaryGateWitness | null;
  boundaryFixedToleranceViolationCount: number;
  boundaryFirstFixedToleranceViolationWitness: BoundaryGateWitness | null;
};

export type NodeResult = {
  successProbability: number;
  expectedConsumption: Stock;
  manualEntryProbability: number;
  expectedManualEntries: number;
  successAttemptSelectionProbability: number;
  expectedSuccessAttemptSelections: number;
};

export type PolicyDecision = {
  possible: boolean;
  best: {
    firstAction: Kit;
    run: { count: number };
    probabilityGap: number;
  } | null;
};

export type ExactEvaluationProgress = {
  scenarioId: string;
  modelId: ModelId;
  elapsedMs: number;
  solveCalls: number;
  cachedNodes: number;
  cachedPolicies: number;
  internalDecisionCount: number;
  internalMaxGap: number;
  internalViolationCount: number;
  boundaryDecisionCount: number;
  boundaryMaxGap: number;
  boundaryViolationCount: number;
};

export type ExactInteractiveEvaluation =
  | {
      status: "completed";
      scenario: SolverScenario;
      modelId: ModelId;
      elapsedMs: number;
      solveCalls: number;
      cachedNodes: number;
      cachedPolicies: number;
      gateEvidence: GateEvidence;
      successProbability: number;
      expectedConsumption: Stock;
      interactiveF: number;
      manualEntryProbability: number;
      expectedManualEntries: number;
      successAttemptSelectionProbability: number;
      expectedSuccessAttemptSelections: number;
    }
  | {
      status: "verification_incomplete";
      reason: "time_budget_exceeded";
      scenario: SolverScenario;
      modelId: ModelId;
      elapsedMs: number;
      solveCalls: number;
      cachedNodes: number;
      cachedPolicies: number;
      gateEvidence: GateEvidence;
    };

export type ExactInteractiveReplanSession = {
  advance: (timeBudgetMs?: number) => ExactInteractiveEvaluation;
  checkpoint: () => ExactInteractiveReplanCheckpoint;
};

export type ExactInteractiveReplanCheckpoint = {
  version: 1;
  scenarioId: string;
  modelId: ModelId;
  costModel: ResearchCostModel;
  activeElapsedMs: number;
  solveCalls: number;
  gateEvidence: GateEvidence;
  cachedNodes: Array<[string, NodeResult]>;
  cachedPolicies: Array<[string, PolicyDecision]>;
  completedNode: NodeResult | null;
};
