import { useCallback, useRef, useState } from "react";
import type { DetailView, LoadingView, ResultView, ValidationView } from "../ui-types";
import { useCalculatorAppLifecycle, useInputChangeTracker } from "./calculatorAppLifecycle";
import { makeCalculatorAppModel } from "./calculatorAppModel";
import { useStateFeedbackNotifier } from "./calculatorFeedback";
import { useSolverProgressLoading } from "./calculatorProgressLoading";
import {
  DEFAULT_LOADING_TEXT,
  EMPTY_DETAIL,
  EMPTY_RESULT,
  INITIAL_VALIDATION,
  type PendingStatsEvent,
  type SolverResult,
} from "./calculatorShared";
import { useSolveFlow } from "./calculatorSolveFlow";
import { useStaleAwareResultRendering } from "./calculatorStaleResult";
import { useGuardedStockSetter } from "./calculatorStockEditGuard";
import { useValidationCoordinator, useValidationFlow } from "./calculatorValidationFlow";
import { useCalculatorState } from "./useCalculatorState";
import { useOutcomeFlow } from "./useOutcomeFlow";
import { useSolverWorker } from "./useSolverWorker";
import { useStats } from "./useStats";
import { useTheme } from "./useTheme";

type ConfiguredOutcomeFlowOptions = Omit<
  Parameters<typeof useOutcomeFlow>[0],
  | "currentStockSnapshot"
  | "setCollectionState"
  | "setManualStockEditRequired"
  | "setStockCountForKit"
> & {
  calculatorState: ReturnType<typeof useCalculatorState>;
};

function useConfiguredOutcomeFlow({ calculatorState, ...options }: ConfiguredOutcomeFlowOptions) {
  const currentStockSnapshot = useCallback(
    () => calculatorState.stateRef.current.stock,
    [calculatorState.stateRef],
  );
  return useOutcomeFlow({
    ...options,
    currentStockSnapshot,
    setCollectionState: calculatorState.setCollectionState,
    setManualStockEditRequired: calculatorState.setManualStockEditRequired,
    setStockCountForKit: calculatorState.setStockCountForKit,
  });
}

export function useCalculatorApp(statsQueryEnabled = false) {
  const [resultView, setResultView] = useState<ResultView>(EMPTY_RESULT);
  const [detailView, setDetailView] = useState<DetailView>(EMPTY_DETAIL);
  const [validationView, setValidationView] = useState<ValidationView>(INITIAL_VALIDATION);
  const [loading, setLoading] = useState<LoadingView>({
    active: false,
    text: DEFAULT_LOADING_TEXT,
  });
  const [staleSource, setStaleSource] = useState<"state" | "stock" | null>(null);
  const actionTransitionIdRef = useRef(0);
  const latestResultRef = useRef<SolverResult | null>(null);
  const pendingStatsEventRef = useRef<PendingStatsEvent | null>(null);
  const { recordStateFeedback, stateFeedback } = useStateFeedbackNotifier();
  const updateProgress = useSolverProgressLoading(setLoading);
  const { cancelValidationForSolve, solveBestAvailable, validateBestAvailable } =
    useSolverWorker(updateProgress);

  const {
    clearActionTransition,
    clearResultStale,
    isResultStale,
    markInputChanged,
    renderMaxLevelState,
    renderResult,
  } = useStaleAwareResultRendering({
    actionTransitionIdRef,
    latestResultRef,
    resultView,
    setDetailView,
    setResultView,
    setValidationView,
  });

  const {
    generationRef: validationGenerationRef,
    invalidateValidation,
    prepareForSolve,
  } = useValidationCoordinator({ cancelValidationForSolve, setValidationView });

  const handleInputChanged = useInputChangeTracker(setStaleSource, markInputChanged);

  const calculatorState = useCalculatorState({
    onInputChanged: handleInputChanged,
    onMaxLevelState: renderMaxLevelState,
  });
  const { currentStateSnapshot, grade, resetState } = calculatorState;
  const theme = useTheme(grade);
  const stats = useStats(statsQueryEnabled);

  const outcomeFlow = useConfiguredOutcomeFlow({
    calculatorState,
    currentStateSnapshot,
    latestResultRef,
    pendingStatsEventRef,
    setDetailView,
    setResultView,
    setValidationView,
    queueStatsEvent: stats.queueStatsEvent,
    recordStateFeedback,
  });

  const runMonteCarloValidation = useValidationFlow({
    generationRef: validationGenerationRef,
    latestResultRef,
    setValidationView,
    validateBestAvailable,
  });
  const { applyOutcomeAndMaybeCalculate, runCalculation } = useSolveFlow({
    applyOutcome: outcomeFlow.applyOutcome,
    collectInput: calculatorState.collectInput,
    currentStateSnapshot,
    latestResultRef,
    pendingStatsEventRef,
    prepareForSolve,
    queueStatsEvent: stats.queueStatsEvent,
    renderResult,
    setCalculateBusy: calculatorState.setCalculateBusy,
    setDetailView,
    setLoading,
    setResultView,
    solveBestAvailable,
  });

  const setStock = useGuardedStockSetter({
    currentStateSnapshot,
    manualStockEditRequired: calculatorState.manualStockEditRequired,
    pendingStatsEventRef,
    setStock: calculatorState.actions.setStock,
  });

  const { calculateAndClearStale, resetInputs } = useCalculatorAppLifecycle({
    clearResultStale,
    invalidateValidation,
    latestResultRef,
    outcomeFlow,
    pendingStatsEventRef,
    resetState,
    runCalculation,
    setDetailView,
    setResultView,
    setStaleSource,
    setValidationView,
  });

  return makeCalculatorAppModel({
    applyOutcomeAndMaybeCalculate,
    calculatorState,
    clearActionTransition,
    detailView,
    isResultStale,
    staleSource,
    loading,
    outcomeFlow,
    resetInputs,
    resultView,
    runCalculation: calculateAndClearStale,
    runMonteCarloValidation,
    setStock,
    stateFeedback,
    statsView: stats.statsView,
    theme,
    validationView,
  });
}
