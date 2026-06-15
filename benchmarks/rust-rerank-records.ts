import type { ScenarioRecord } from "./rust-rerank-summary-model.ts";

export type ScenarioRecordBase = Pick<
  ScenarioRecord,
  | "group"
  | "scenarioId"
  | "source"
  | "start"
  | "stockBlue"
  | "stockPurple"
  | "stockYellow"
  | "weight"
>;

export function emptyScenarioRecord(
  base: ScenarioRecordBase,
  status: Extract<ScenarioRecord["status"], "error" | "no-action">,
  elapsedMs: number,
  overrides: Partial<ScenarioRecord> = {},
): ScenarioRecord {
  return {
    ...base,
    status,
    candidateCount: 0,
    baselineFirstAction: null,
    selectedFirstAction: null,
    intervened: false,
    baselineSuccessProbability: null,
    selectedSuccessProbability: null,
    selectedProbabilityGap: null,
    selectedProbabilityLossVsBaseline: null,
    inSampleBaselineExpectedCost: null,
    inSampleSelectedExpectedCost: null,
    inSampleDeltaVsBaseline: null,
    inSampleCompletionRate: null,
    heldOutBaselineExpectedCost: null,
    heldOutSelectedExpectedCost: null,
    heldOutDeltaVsBaseline: null,
    heldOutBaselineCompletionRate: null,
    heldOutSelectedCompletionRate: null,
    heldOutNonWorse: null,
    heldOutStrictImproved: null,
    rawEvaluationDeltaVsBaseline: null,
    rawEvaluationStandardError: null,
    rawEvaluationUpper95: null,
    rawEvaluationSeedSpread: null,
    twoFoldGatePass: null,
    twoFoldIntervened: false,
    twoFoldEvaluationDeltaVsBaseline: null,
    twoFoldFalsePositive: null,
    twoFoldFalseNegative: null,
    paired95GatePass: null,
    paired95Intervened: false,
    paired95EvaluationDeltaVsBaseline: null,
    paired95FalsePositive: null,
    paired95FalseNegative: null,
    adaptive90RawSelectedFirstAction: null,
    adaptive90SelectedFirstAction: null,
    adaptive90GatePass: null,
    adaptive90Intervened: false,
    adaptive90EvaluationDeltaVsBaseline: null,
    adaptive90FalsePositive: null,
    adaptive90FalseNegative: null,
    adaptive90GateRuns: null,
    adaptive90GateMeanDelta: null,
    adaptive90GateStandardError: null,
    adaptive90GateUpperBound: null,
    adaptive90GateCorrelation: null,
    a2GatePass: null,
    a2GateIntervened: false,
    a2GateEvaluationDeltaVsBaseline: null,
    a2GateFalsePositive: null,
    a2GateFalseNegative: null,
    gatePairMeanDelta: null,
    gatePairStandardError: null,
    gatePairUpper95: null,
    gatePairCorrelation: null,
    a2BaselineSurrogateCost: null,
    a2SelectedSurrogateCost: null,
    a2DeltaVsBaseline: null,
    a2NodeCount: null,
    a2ErrorMessage: null,
    a1BaselineExactCost: null,
    a1SelectedExactCost: null,
    a1DeltaVsBaseline: null,
    a1NodeCount: null,
    a1ErrorMessage: null,
    elapsedMs,
    ...overrides,
  };
}
