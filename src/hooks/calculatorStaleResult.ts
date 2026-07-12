import { type Dispatch, type RefObject, type SetStateAction, useCallback, useState } from "react";

import type { Grade } from "../types";
import type { DetailView, RecommendationAction, ResultView, ValidationView } from "../ui-types";
import { useCalculatorResultRendering } from "./calculatorResultRendering";
import {
  EMPTY_DETAIL,
  EMPTY_RESULT,
  INITIAL_VALIDATION,
  type SolverResult,
} from "./calculatorShared";

type StaleResultOptions = {
  actionTransitionIdRef: RefObject<number>;
  latestResultRef: RefObject<SolverResult | null>;
  resultView: ResultView;
  setDetailView: Dispatch<SetStateAction<DetailView>>;
  setResultView: Dispatch<SetStateAction<ResultView>>;
  setValidationView: Dispatch<SetStateAction<ValidationView>>;
};

function isMaxLevelGeneratedResult(view: ResultView) {
  return (
    view.type === "convertRecommendation" ||
    (view.type === "callout" && view.reason === "final_target")
  );
}

export function useStaleAwareResultRendering({
  actionTransitionIdRef,
  latestResultRef,
  resultView,
  setDetailView,
  setResultView,
  setValidationView,
}: StaleResultOptions) {
  const [isResultStale, setResultStale] = useState(false);

  const markInputChanged = useCallback(
    (isManualStockEditRequired: boolean) => {
      const hadResult = latestResultRef.current !== null;
      if (isManualStockEditRequired) return;
      if (hadResult) {
        setResultStale(true);
        return;
      }
      latestResultRef.current = null;
      setValidationView(INITIAL_VALIDATION);
      if (isMaxLevelGeneratedResult(resultView)) {
        setResultView(EMPTY_RESULT);
        setDetailView(EMPTY_DETAIL);
      }
    },
    [latestResultRef, resultView, setDetailView, setResultView, setValidationView],
  );

  const {
    clearActionTransition,
    renderMaxLevelState: renderMaxLevelStateBase,
    renderResult: renderResultBase,
  } = useCalculatorResultRendering({
    actionTransitionIdRef,
    latestResultRef,
    setDetailView,
    setResultView,
    setValidationView,
  });

  const clearResultStale = useCallback(() => setResultStale(false), []);

  const renderMaxLevelState = useCallback(
    (nextGrade: Grade, nextLevel: number) => {
      clearResultStale();
      if (isMaxLevelGeneratedResult(resultView)) {
        latestResultRef.current = null;
        setResultView(EMPTY_RESULT);
        setDetailView(EMPTY_DETAIL);
        setValidationView(INITIAL_VALIDATION);
        return;
      }
      renderMaxLevelStateBase(nextGrade, nextLevel);
    },
    [
      clearResultStale,
      latestResultRef,
      renderMaxLevelStateBase,
      resultView,
      setDetailView,
      setResultView,
      setValidationView,
    ],
  );

  const renderResult = useCallback(
    (result: SolverResult, previousAction?: RecommendationAction | null) => {
      clearResultStale();
      renderResultBase(result, previousAction);
    },
    [clearResultStale, renderResultBase],
  );

  return {
    clearActionTransition,
    clearResultStale,
    isResultStale,
    markInputChanged,
    renderMaxLevelState,
    renderResult,
  };
}
