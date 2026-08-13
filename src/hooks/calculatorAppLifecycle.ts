import { type RefObject, useCallback } from "react";

import type { DetailView, ResultView, ValidationView } from "../ui-types";
import {
  EMPTY_DETAIL,
  EMPTY_RESULT,
  INITIAL_VALIDATION,
  type PendingStatsEvent,
  type SolverResult,
} from "./calculatorShared";
import type { useOutcomeFlow } from "./useOutcomeFlow";

type AppLifecycleOptions = {
  clearResultStale: () => void;
  invalidateValidation: () => void;
  invalidateSolveInput: () => void;
  latestResultRef: RefObject<SolverResult | null>;
  outcomeFlow: Pick<ReturnType<typeof useOutcomeFlow>, "resetOutcomeFlow">;
  setPendingStatsEvent: (event: PendingStatsEvent | null) => void;
  resetState: () => void;
  runCalculation: () => Promise<boolean>;
  setDetailView: React.Dispatch<React.SetStateAction<DetailView>>;
  setResultView: React.Dispatch<React.SetStateAction<ResultView>>;
  setStaleSource: React.Dispatch<React.SetStateAction<"state" | "stock" | null>>;
  setValidationView: React.Dispatch<React.SetStateAction<ValidationView>>;
};

export function useInputChangeTracker(
  setStaleSource: React.Dispatch<React.SetStateAction<"state" | "stock" | null>>,
  markInputChanged: (manualStockEditRequired: boolean, source: "state" | "stock") => void,
) {
  return useCallback(
    (manualStockEditRequired: boolean, source: "state" | "stock") => {
      setStaleSource(source);
      markInputChanged(manualStockEditRequired, source);
    },
    [markInputChanged, setStaleSource],
  );
}

export function useCalculatorAppLifecycle({
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
}: AppLifecycleOptions) {
  const calculateAndClearStale = useCallback(async () => {
    const started = await runCalculation();
    if (!started) return false;
    clearResultStale();
    setStaleSource(null);
    return true;
  }, [clearResultStale, runCalculation, setStaleSource]);

  const resetInputs = useCallback(() => {
    invalidateValidation();
    invalidateSolveInput();
    setPendingStatsEvent(null);
    latestResultRef.current = null;
    clearResultStale();
    setStaleSource(null);
    outcomeFlow.resetOutcomeFlow();
    resetState();
    setResultView(EMPTY_RESULT);
    setDetailView(EMPTY_DETAIL);
    setValidationView(INITIAL_VALIDATION);
  }, [
    clearResultStale,
    invalidateValidation,
    invalidateSolveInput,
    latestResultRef,
    outcomeFlow,
    resetState,
    setDetailView,
    setResultView,
    setPendingStatsEvent,
    setStaleSource,
    setValidationView,
  ]);

  return { calculateAndClearStale, resetInputs };
}
