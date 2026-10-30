import { useCallback, useRef, useState } from "react";
import { observeDecision, type DecisionLifecycle } from "../analytics/decisionLifecycle";
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
  sameState,
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
import { SERVICE_CERTIFIED_SOLVER } from "../lib/serviceCertified";
import { useServiceCertifiedSolver } from "./useServiceCertifiedSolver";
import { withoutRecommendedWait } from "./serviceCertifiedPresentation";

// A build-time constant selects one hook for this App's entire lifetime, never two engines.
const useCalculatorSolver = SERVICE_CERTIFIED_SOLVER ? useServiceCertifiedSolver : useSolverWorker;

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

export function useCalculatorApp(statsQueryEnabled = false, lifecycle?: DecisionLifecycle) {
  const observerOwner = observeDecision(lifecycle ? () => lifecycle.captureOutcomeOwner() : undefined);
  const [resultView, setResultView] = useState<ResultView>(EMPTY_RESULT);
  const [detailView, setDetailView] = useState<DetailView>(EMPTY_DETAIL);
  const [validationView, setValidationView] = useState<ValidationView>(INITIAL_VALIDATION);
  const [loading, setLoading] = useState<LoadingView>({
    active: false,
    text: DEFAULT_LOADING_TEXT,
  });
  const getCurrentViews = useCallback(
    () => ({ detail: detailView, result: resultView }),
    [detailView, resultView],
  );
  const [staleSource, setStaleSource] = useState<"state" | "stock" | null>(null);
  const actionTransitionIdRef = useRef(0);
  const inputRevisionRef = useRef(0);
  const latestResultRef = useRef<SolverResult | null>(null);
  const resetOutcomeRef = useRef<(() => void) | null>(null);
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
  const solver = useCalculatorSolver(
    updateProgress,
    reportRuntimeInvariant,
  );
  const { cancelValidationForSolve, solveBestAvailable, validateBestAvailable } = solver;
  const retireService = "invalidateSolve" in solver ? solver.invalidateSolve : undefined;
  const checkForecastBoundary = "checkForecastBoundary" in solver ? solver.checkForecastBoundary : undefined;

  const {
    clearActionTransition,
    clearResultStale,
    isResultStale,
    markResultStale,
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
  const forecastInvalidated = useCallback(() => {
    if (observerOwner !== undefined)
      observeDecision(lifecycle ? () => lifecycle.retire(observerOwner, "forecast_invalid") : undefined);
    ++inputRevisionRef.current;
    // Mark before removing executable ownership. A forecast change is not a
    // physical stock edit and must not discard recorded/pending stock history.
    markInputChanged(false, "state");
    // An ordinary error clears executable ownership before its deferred error
    // render. Retained Current metrics still need a stale marker if B arrives.
    if (detailView.type === "metrics") markResultStale();
    latestResultRef.current = null;
    setDetailView(withoutRecommendedWait);
    setResultView((current) => current.type === "loading" ? EMPTY_RESULT : current);
    resetOutcomeRef.current?.();
  }, [detailView.type, markInputChanged, markResultStale, lifecycle, observerOwner]);
  if ("forecastInvalidationRef" in solver)
    solver.forecastInvalidationRef.current = forecastInvalidated;

  const {
    generationRef: validationGenerationRef,
    invalidateValidation,
    prepareForSolve,
  } = useValidationCoordinator({
    cancelValidationForSolve,
    reportRuntimeInvariant,
    setValidationView,
  });
  const prepareOwnedSolve = useCallback(() => {
    // A new explicit request replaces the recommendation behind an open modal,
    // even if B is first discovered by that request's own acquisition.
    if (SERVICE_CERTIFIED_SOLVER) resetOutcomeRef.current?.();
    prepareForSolve();
  }, [prepareForSolve]);

  const trackInputChanged = useInputChangeTracker(setStaleSource, markInputChanged);
  const handleInputChanged = useCallback(
    (manualStockEditRequired: boolean, source: "state" | "stock") => {
      inputRevisionRef.current += 1;
      trackInputChanged(manualStockEditRequired, source);
      if (retireService) {
        retireService();
        latestResultRef.current = null;
        setDetailView(withoutRecommendedWait);
        setResultView((current) => current.type === "loading" ? EMPTY_RESULT : current);
      }
    },
    [retireService, trackInputChanged],
  );
  const invalidateSolveInput = useCallback(() => {
    inputRevisionRef.current += 1;
    retireService?.();
    setDetailView(withoutRecommendedWait);
  }, [retireService]);

  const onInputRestored = useCallback(() => {
    if (observerOwner !== undefined)
      observeDecision(lifecycle ? () => lifecycle.retire(observerOwner, "restore") : undefined);
    invalidateSolveInput();
    latestResultRef.current = null;
    setPendingStatsEvent(null);
    resetOutcomeRef.current?.();
    clearResultStale();
    setStaleSource(null);
    setResultView(EMPTY_RESULT);
    setDetailView(EMPTY_DETAIL);
  }, [clearResultStale, invalidateSolveInput, setPendingStatsEvent, lifecycle, observerOwner]);

  const onMaxLevelState = useCallback((nextGrade: Parameters<typeof renderMaxLevelState>[0], level: number) => {
    if (retireService) invalidateSolveInput();
    renderMaxLevelState(nextGrade, level);
  }, [invalidateSolveInput, renderMaxLevelState, retireService]);

  const calculatorState = useCalculatorState({
    onBeforeInputMutation: () => {
      if (observerOwner !== undefined) {
        observeDecision(lifecycle ? () => lifecycle.explicitAction?.(observerOwner, "input_edit") : undefined);
        observeDecision(lifecycle ? () => lifecycle.retire(observerOwner, "input_edit") : undefined);
      }
    },
    onInputChanged: handleInputChanged,
    onMaxLevelState,
    ...(SERVICE_CERTIFIED_SOLVER ? { onInputRestored } : {}),
  });
  const { currentStateSnapshot, grade, resetState } = calculatorState;
  const theme = useTheme(grade);

  const outcomeFlow = useConfiguredOutcomeFlow({
    ...(lifecycle ? { lifecycle } : {}),
    observerOwner,
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
  resetOutcomeRef.current = outcomeFlow.resetOutcomeFlow;
  const applyOwnedOutcome = useCallback((outcome: "success" | "fail") => {
    if (SERVICE_CERTIFIED_SOLVER) {
      if (checkForecastBoundary?.() === false) return null;
      if (!sameState(currentStateSnapshot(), latestResultRef.current?.input?.start)) return null;
      setDetailView(withoutRecommendedWait);
    }
    return outcomeFlow.applyOutcome(outcome);
  }, [checkForecastBoundary, currentStateSnapshot, outcomeFlow.applyOutcome]);
  const runMonteCarloValidation = useValidationFlow({
    generationRef: validationGenerationRef,
    latestResultRef,
    reportRuntimeInvariant,
    setValidationView,
    validateBestAvailable,
  });
  const { applyConvertAndCalculate, applyOutcomeAndMaybeCalculate, runCalculation, captureCalculationOwnership } = useSolveFlow({
    ...(lifecycle ? { lifecycle } : {}),
    observerOwner,
    ...(checkForecastBoundary ? { checkForecastBoundary } : {}),
    applyConvert: outcomeFlow.applyConvert,
    applyOutcome: applyOwnedOutcome,
    collectInput: calculatorState.collectInput,
    getCurrentViews,
    inputRevisionRef,
    latestResultRef,
    pendingStatsEventRef,
    prepareForSolve: prepareOwnedSolve,
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
  const ownsRenderedOutcome = captureCalculationOwnership();
  const submitOwnedSuccessAttempt = useCallback((attempt: number | null) => {
    if (!ownsRenderedOutcome() || checkForecastBoundary?.() === false) return;
    outcomeFlow.submitSuccessAttempt(attempt);
  }, [checkForecastBoundary, outcomeFlow.submitSuccessAttempt, ownsRenderedOutcome]);

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
    captureCalculationOwnership,
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
    outcomeFlow: { ...outcomeFlow, submitSuccessAttempt: submitOwnedSuccessAttempt },
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
    validationView: SERVICE_CERTIFIED_SOLVER ? { ...validationView, disabled: true } : validationView,
  });
}
