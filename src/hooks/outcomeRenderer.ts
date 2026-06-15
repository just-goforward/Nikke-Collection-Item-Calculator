import { useCallback } from "react";

import { stateText as describeState } from "../solver/domain";
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
    ({ best, detailMessage, nextState, outcomeLabel, run, stockMessage }: OutcomeRenderArgs) => {
      setResultView({
        type: "outcome",
        kit: best.firstAction,
        count: run.count,
        outcomeLabel,
        stateText: describeState(nextState),
        stockMessage,
        showConvertRecommendation: nextState.grade === "R" && nextState.level >= 15,
      });
      setDetailView({ type: "empty", message: detailMessage });
      setValidationView(INITIAL_VALIDATION);
      latestResultRef.current = null;
    },
    [latestResultRef, setDetailView, setResultView, setValidationView],
  );
}
