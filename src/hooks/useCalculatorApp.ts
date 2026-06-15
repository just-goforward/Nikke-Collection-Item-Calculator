import { useCallback, useRef, useState } from "react";
import type { DetailView, LoadingView, ResultView, ValidationView } from "../ui-types";
import { makeCalculatorAppModel } from "./calculatorAppModel";
import { useStateFeedbackNotifier } from "./calculatorFeedback";
import { useSolverProgressLoading } from "./calculatorProgressLoading";
import { useCalculatorResultRendering } from "./calculatorResultRendering";
import {
  DEFAULT_LOADING_TEXT,
  EMPTY_DETAIL,
  EMPTY_RESULT,
  INITIAL_VALIDATION,
  type PendingStatsEvent,
  type SolverResult,
} from "./calculatorShared";
import { useSolveFlow } from "./calculatorSolveFlow";
import { useValidationFlow } from "./calculatorValidationFlow";
import { useCalculatorState } from "./useCalculatorState";
import { useOutcomeFlow } from "./useOutcomeFlow";
import { useSolverWorker } from "./useSolverWorker";
import { useStats } from "./useStats";
import { useTheme } from "./useTheme";

export function useCalculatorApp() {
  const [resultView, setResultView] = useState<ResultView>(EMPTY_RESULT);
  const [detailView, setDetailView] = useState<DetailView>(EMPTY_DETAIL);
  const [validationView, setValidationView] = useState<ValidationView>(INITIAL_VALIDATION);
  const [loading, setLoading] = useState<LoadingView>({
    active: false,
    text: DEFAULT_LOADING_TEXT,
  });
  const actionTransitionIdRef = useRef(0);
  const latestResultRef = useRef<SolverResult | null>(null);
  const pendingStatsEventRef = useRef<PendingStatsEvent | null>(null);
  const { recordStateFeedback, stateFeedback } = useStateFeedbackNotifier();

  const markInputChanged = useCallback((isManualStockEditRequired: boolean) => {
    latestResultRef.current = null;
    setValidationView(INITIAL_VALIDATION);
    if (!isManualStockEditRequired) {
      setResultView(EMPTY_RESULT);
      setDetailView(EMPTY_DETAIL);
    }
  }, []);

  const { renderMaxLevelState, renderResult } = useCalculatorResultRendering({
    actionTransitionIdRef,
    latestResultRef,
    setDetailView,
    setResultView,
    setValidationView,
  });

  const calculatorState = useCalculatorState({
    onInputChanged: markInputChanged,
    onMaxLevelState: renderMaxLevelState,
  });
  const {
    grade,
    stateRef,
    setCollectionState,
    setStockCountForKit,
    setManualStockEditRequired,
    setCalculateBusy,
    collectInput,
    currentStateSnapshot,
    resetState,
  } = calculatorState;
  const theme = useTheme(grade);
  const stats = useStats();

  const currentStockSnapshot = useCallback(() => stateRef.current.stock, [stateRef]);
  const outcomeFlow = useOutcomeFlow({
    latestResultRef,
    pendingStatsEventRef,
    currentStockSnapshot,
    setCollectionState,
    setStockCountForKit,
    setManualStockEditRequired,
    setResultView,
    setDetailView,
    setValidationView,
    queueStatsEvent: stats.queueStatsEvent,
    currentStateSnapshot,
    recordStateFeedback,
  });

  const updateProgress = useSolverProgressLoading(setLoading);
  const { solveBestAvailable, validateBestAvailable } = useSolverWorker(updateProgress);
  const runMonteCarloValidation = useValidationFlow({
    latestResultRef,
    setValidationView,
    validateBestAvailable,
  });
  const { applyOutcomeAndMaybeCalculate, runCalculation } = useSolveFlow({
    applyOutcome: outcomeFlow.applyOutcome,
    collectInput,
    currentStateSnapshot,
    latestResultRef,
    pendingStatsEventRef,
    queueStatsEvent: stats.queueStatsEvent,
    renderResult,
    setCalculateBusy,
    setDetailView,
    setLoading,
    setResultView,
    solveBestAvailable,
  });

  const resetInputs = useCallback(() => {
    pendingStatsEventRef.current = null;
    latestResultRef.current = null;
    outcomeFlow.resetOutcomeFlow();
    resetState();
    setResultView(EMPTY_RESULT);
    setDetailView(EMPTY_DETAIL);
    setValidationView(INITIAL_VALIDATION);
  }, [outcomeFlow, resetState]);

  return makeCalculatorAppModel({
    applyOutcomeAndMaybeCalculate,
    calculatorState,
    detailView,
    loading,
    outcomeFlow,
    resetInputs,
    resultView,
    runCalculation,
    runMonteCarloValidation,
    stateFeedback,
    statsView: stats.statsView,
    theme,
    validationView,
  });
}
