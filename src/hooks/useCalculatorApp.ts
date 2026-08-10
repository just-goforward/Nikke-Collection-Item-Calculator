import { useCallback, useRef, useState } from "react";
import type {
  DetailView,
  LoadingView,
  ResultView,
  StockCorrectionView,
  ValidationView,
} from "../ui-types";
import { useCalculatorAppLifecycle, useInputChangeTracker } from "./calculatorAppLifecycle";
import { makeCalculatorAppModel } from "./calculatorAppModel";
import { makeRuntimeInvariantEvent, type RuntimeInvariantReporter } from "./calculatorDiagnostics";
import { useStateFeedbackNotifier } from "./calculatorFeedback";
import { useSolverProgressLoading } from "./calculatorProgressLoading";
import {
  DEFAULT_LOADING_TEXT,
  EMPTY_DETAIL,
  EMPTY_RESULT,
  INITIAL_VALIDATION,
  type SolverResult,
} from "./calculatorShared";
import { useSolveFlow } from "./calculatorSolveFlow";
import { useStaleAwareResultRendering } from "./calculatorStaleResult";
import {
  type PendingStockCorrectionResolution,
  resolvePendingStockCorrection,
} from "./calculatorStockCorrection";
import { useGuardedStockSetter } from "./calculatorStockEditGuard";
import { useValidationCoordinator, useValidationFlow } from "./calculatorValidationFlow";
import { useCalculatorState } from "./useCalculatorState";
import { useOutcomeFlow } from "./useOutcomeFlow";
import { usePendingStatsEvent } from "./usePendingStatsEvent";
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

function stockCorrectionView(
  resolution: PendingStockCorrectionResolution,
): StockCorrectionView | null {
  if (resolution.status === "none") return null;
  const view = {
    allowedMaximum: resolution.allowedMaximum,
    allowedMinimum: resolution.allowedMinimum,
    beforeStock: resolution.beforeStock,
    canCalculate: resolution.canCalculate,
    currentStock: resolution.currentStock,
    kit: resolution.kit,
    recommendedUses: resolution.recommendedUses,
  };
  if (resolution.status === "valid") {
    return { ...view, status: "valid", successAttempt: resolution.successAttempt };
  }
  return { ...view, status: "invalid", reason: resolution.reason };
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
  const inputRevisionRef = useRef(0);
  const latestResultRef = useRef<SolverResult | null>(null);
  const { pendingStatsEvent, pendingStatsEventRef, setPendingStatsEvent } = usePendingStatsEvent();
  const { recordStateFeedback, stateFeedback } = useStateFeedbackNotifier();
  const updateProgress = useSolverProgressLoading(setLoading);
  const stats = useStats(statsQueryEnabled);
  const reportRuntimeInvariant = useCallback<RuntimeInvariantReporter>(
    (code, component, lane) => {
      try {
        stats.queueStatsEvent(makeRuntimeInvariantEvent(code, component, lane));
      } catch (error) {
        console.error("Runtime invariant diagnostic could not be queued.", error);
      }
    },
    [stats.queueStatsEvent],
  );
  const { cancelValidationForSolve, solveBestAvailable, validateBestAvailable } = useSolverWorker(
    updateProgress,
    reportRuntimeInvariant,
  );

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
  } = useValidationCoordinator({
    cancelValidationForSolve,
    reportRuntimeInvariant,
    setValidationView,
  });

  const trackInputChanged = useInputChangeTracker(setStaleSource, markInputChanged);
  const handleInputChanged = useCallback(
    (manualStockEditRequired: boolean, source: "state" | "stock") => {
      inputRevisionRef.current += 1;
      trackInputChanged(manualStockEditRequired, source);
    },
    [trackInputChanged],
  );
  const invalidateSolveInput = useCallback(() => {
    inputRevisionRef.current += 1;
  }, []);

  const calculatorState = useCalculatorState({
    onInputChanged: handleInputChanged,
    onMaxLevelState: renderMaxLevelState,
  });
  const { currentStateSnapshot, grade, resetState } = calculatorState;
  const theme = useTheme(grade);

  const outcomeFlow = useConfiguredOutcomeFlow({
    calculatorState,
    currentStateSnapshot,
    latestResultRef,
    pendingStatsEventRef,
    setPendingStatsEvent,
    setDetailView,
    setResultView,
    setValidationView,
    queueStatsEvent: stats.queueStatsEvent,
    recordStateFeedback,
  });

  const runMonteCarloValidation = useValidationFlow({
    generationRef: validationGenerationRef,
    latestResultRef,
    reportRuntimeInvariant,
    setValidationView,
    validateBestAvailable,
  });
  const { applyConvertAndCalculate, applyOutcomeAndMaybeCalculate, runCalculation } = useSolveFlow({
    applyConvert: outcomeFlow.applyConvert,
    applyOutcome: outcomeFlow.applyOutcome,
    collectInput: calculatorState.collectInput,
    inputRevisionRef,
    latestResultRef,
    pendingStatsEventRef,
    prepareForSolve,
    queueStatsEvent: stats.queueStatsEvent,
    renderResult,
    setCalculateBusy: calculatorState.setCalculateBusy,
    setDetailView,
    setLoading,
    setManualStockEditRequired: calculatorState.setManualStockEditRequired,
    setPendingStatsEvent,
    setResultView,
    solveBestAvailable,
  });

  const setStock = useGuardedStockSetter({
    setStock: calculatorState.actions.setStock,
  });

  const correctionResolution = calculatorState.manualStockEditRequired
    ? resolvePendingStockCorrection(
        pendingStatsEvent,
        {
          grade: calculatorState.grade,
          level: calculatorState.level,
          exp: calculatorState.exp,
        },
        calculatorState.stock,
      )
    : ({ status: "none" } as const);
  const correction = stockCorrectionView(correctionResolution);
  const { calculateAndClearStale, resetInputs } = useCalculatorAppLifecycle({
    clearResultStale,
    invalidateValidation,
    invalidateSolveInput,
    latestResultRef,
    outcomeFlow,
    setPendingStatsEvent,
    resetState,
    runCalculation,
    setDetailView,
    setResultView,
    setStaleSource,
    setValidationView,
  });

  return makeCalculatorAppModel({
    applyConvertAndCalculate,
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
    retryStats: stats.retryStats,
    setStock,
    stockCorrection: correction,
    stateFeedback,
    statsView: stats.statsView,
    theme,
    validationView,
  });
}
