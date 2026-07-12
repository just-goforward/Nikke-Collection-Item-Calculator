import { useCallback } from "react";

import { INITIAL_VALIDATION } from "./calculatorShared";
import type { OutcomeRenderArgs, OutcomeSharedOptions } from "./outcomeFlowTypes";

export function useOutcomeRenderer({
  latestResultRef,
  setDetailView,
  setResultView,
  setValidationView,
}: Pick<
  OutcomeSharedOptions,
  "latestResultRef" | "setDetailView" | "setResultView" | "setValidationView"
>) {
  return useCallback(
    ({
      best,
      detailMessage,
      nextState,
      outcome,
      preserveExistingResult,
      run,
      stockMessage,
    }: OutcomeRenderArgs) => {
      if (preserveExistingResult) return;
      setResultView({
        type: "outcome",
        kit: best.firstAction,
        count: run.count,
        outcome,
        state: nextState,
        stockMessage,
        canConvert: nextState.grade === "R" && nextState.level >= 15,
      });
      setDetailView({ type: "empty", message: detailMessage });
      setValidationView(INITIAL_VALIDATION);
      latestResultRef.current = null;
    },
    [latestResultRef, setDetailView, setResultView, setValidationView],
  );
}
