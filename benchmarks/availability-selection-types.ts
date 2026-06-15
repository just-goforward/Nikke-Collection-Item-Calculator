import type { Stock } from "../src/types";

export type GateEvidenceSummary = {
  eligibleEmptyCount: number;
  internalViolationCount: number;
  boundaryViolationCount: number;
};

export type RawGateEvidence = Partial<GateEvidenceSummary> & {
  violationCount?: number;
};

export type ExactEntry = {
  modelId: string;
  scenario: string;
  status: string;
  reason?: string;
  exactLossVsA?: number | null;
  relativeLossVsA?: number | null;
  gateEvidence?: RawGateEvidence | null;
};

export type TailSummary = {
  residualP05?: Partial<Stock>;
  depletionProbability?: number;
  autonomyDaysP05?: number;
};

export type FiniteTailEntry = {
  modelId: string;
  scenario: string;
  status: string;
  summary?: TailSummary;
};

export type JourneyDemandEntry = {
  candidateId: string;
  maxPanelSupplyDebtCvar90?: number | null;
};

export type DeepReport = {
  exactResults: ExactEntry[];
  finiteStockTail: FiniteTailEntry[];
  journeyDemand: JourneyDemandEntry[];
};

export type LoadedDeepReport = {
  report: DeepReport;
  source: string;
};

export type SignificanceCandidate = {
  candidateId: string;
  significantImprovement?: boolean;
};

export type SignificanceLoad =
  | {
      available: true;
      byId: Map<string, SignificanceCandidate>;
    }
  | {
      available: false;
      byId: Map<string, SignificanceCandidate>;
    };

export type GuardrailAggregate = {
  residualP05Min: number;
  depletionProbability: number;
  autonomyDaysP05: number;
  seeds: number;
};

export type CandidateEvaluation = {
  modelId: string;
  worstExactLoss: number | null;
  worstRelativeLoss: number | null;
  gateComplete: boolean;
  gateJudgedCount: number;
  gateTotal: number;
  incompleteReasons: string[];
  gateEvidence: GateEvidenceSummary;
  supplyDebt: number | null;
  supplyDebtJudgeable: boolean;
  finiteByScenario: Map<string, GuardrailAggregate>;
  guard?: GuardrailComparison;
  noLoss?: boolean;
  boundedLoss?: boolean;
  tailStrictlyBetter?: boolean;
  significance?: SignificanceCandidate | null;
  tailSignificantlyBetter?: boolean;
};

export type JudgeableCandidate = CandidateEvaluation & {
  worstExactLoss: number;
  worstRelativeLoss: number;
  supplyDebt: number;
  guard: GuardrailComparison;
  noLoss: boolean;
  boundedLoss: boolean;
  tailStrictlyBetter: boolean;
  significance: SignificanceCandidate | null;
  tailSignificantlyBetter: boolean;
};

export type GuardrailComparison = {
  degraded: boolean;
  degradations: string[];
  anyRiskStratumBetter: boolean;
};

export type StageOutput = {
  stage: "확률우선" | "균형" | "수급보존";
  modelId: string;
  worstExactLoss: number;
  worstRelativeLoss: number | null;
  supplyDebtCvar90: number;
  tailSignificantImprovement: boolean | null;
  guardrailDegraded: boolean;
  guardrailDegradations: string[];
  riskStratumBetter: boolean | null;
};

export type SelectionCandidateOutput = {
  modelId: string;
  worstExactLoss: number | null;
  worstRelativeLoss: number | null;
  supplyDebtCvar90: number | null;
  supplyDebtSignificantImprovement: boolean | null;
  gateComplete: boolean;
  gateJudged: string;
  incompleteReasons: string[];
  gateEvidence: GateEvidenceSummary;
};

export type ImprovedDefaultOutput = {
  modelId: string;
  worstExactLoss: number;
  supplyDebtCvar90: number;
  supplyDebtVsA: number;
  tailSignificantImprovement: boolean;
  riskStratumBetter: boolean;
  provisional: boolean;
};

export type SelectionOutput = {
  kind: "availability-selection";
  version: 1;
  generatedAt: string;
  source: string;
  deltaPBudget: number;
  guardrailTolerances: {
    depletionTolerance: number;
    residualRelTolerance: number;
    autonomyRelTolerance: number;
  };
  baselineId: string;
  significanceAvailable: boolean;
  gateScenarioIds: string[];
  candidates: SelectionCandidateOutput[];
  outcome?: string;
  reason?: string;
  paretoFrontier?: string[];
  stages?: StageOutput[];
  monotone?: boolean;
  baselineSupplyDebt?: number;
  improvedDefaultAvailable?: boolean;
  improvedDefault?: ImprovedDefaultOutput | null;
  dominatorsOfA?: string[];
  preservationProvisional?: boolean;
  preservationEscalationSuggested?: boolean;
  diagnostics?: {
    judgeableCount: number;
    probabilityCandidateCount: number;
    preservationCandidateCount: number;
    dominatorCount: number;
    droppedForFallback: string[];
  };
};
