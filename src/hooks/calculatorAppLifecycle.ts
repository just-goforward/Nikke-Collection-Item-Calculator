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
  latestResultRef: RefObject<SolverResult | null>;
  outcomeFlow: Pick<ReturnType<typeof useOutcomeFlow>, "resetOutcomeFlow">;
  pendingStatsEventRef: RefObject<PendingStatsEvent | null>;
  resetState: () => void;
  runCalculation: () => Promise<void>;
  setDetailView: React.Dispatch<React.SetStateAction<DetailView>>;
  setResultView: React.Dispatch<React.SetStateAction<ResultView>>;
  setStaleSource: React.Dispatch<React.SetStateAction<"state" | "stock" | null>>;
  setValidationView: React.Dispatch<React.SetStateAction<ValidationView>>;
};

export function useInputChangeTracker(
  setStaleSource: React.Dispatch<React.SetStateAction<"state" | "stock" | null>>,
  markInputChanged: (manualStockEditRequired: boolean) => void,
) {
  return useCallback(
    (manualStockEditRequired: boolean, source: "state" | "stock") => {
      setStaleSource(source);
      markInputChanged(manualStockEditRequired);
    },
    [markInputChanged, setStaleSource],
  );
}

export function useCalculatorAppLifecycle({
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
}: AppLifecycleOptions) {
  const calculateAndClearStale = useCallback(async () => {
    await runCalculation();
    clearResultStale();
    setStaleSource(null);
  }, [clearResultStale, runCalculation, setStaleSource]);

  const resetInputs = useCallback(() => {
    invalidateValidation();
    pendingStatsEventRef.current = null;
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
    latestResultRef,
    outcomeFlow,
    pendingStatsEventRef,
    resetState,
    setDetailView,
    setResultView,
    setStaleSource,
    setValidationView,
  ]);

  return { calculateAndClearStale, resetInputs };
}
