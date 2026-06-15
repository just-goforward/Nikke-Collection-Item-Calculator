import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";

import { convertState, stateText as describeState } from "../solver/domain";
import type { CollectionState } from "../types";
import type { DetailView, ResultView, StateChangeFeedback, ValidationView } from "../ui-types";
import { INITIAL_VALIDATION, type SolverResult } from "./calculatorShared";

type ConvertActionOptions = {
  currentStateSnapshot: () => CollectionState;
  latestResultRef: RefObject<SolverResult | null>;
  recordStateFeedback: (from: StateChangeFeedback["from"], to: StateChangeFeedback["to"]) => void;
  setCollectionState: (
    next: CollectionState,
    options?: { maxLevelRender?: boolean; markChanged?: boolean },
  ) => void;
  setDetailView: Dispatch<SetStateAction<DetailView>>;
  setResultView: Dispatch<SetStateAction<ResultView>>;
  setValidationView: Dispatch<SetStateAction<ValidationView>>;
};

export function useConvertAction({
  currentStateSnapshot,
  latestResultRef,
  recordStateFeedback,
  setCollectionState,
  setDetailView,
  setResultView,
  setValidationView,
}: ConvertActionOptions) {
  return useCallback(() => {
    const previousState = currentStateSnapshot();
    const nextState = convertState() as CollectionState;
    recordStateFeedback(previousState, nextState);
    setCollectionState(nextState, { maxLevelRender: false });
    setResultView({
      type: "callout",
      message: `SR 등급으로 교체했습니다. 현재 상태는 ${describeState(nextState)}입니다.`,
    });
    setDetailView({ type: "empty", message: "변경된 상태로 다시 계산하세요." });
    setValidationView(INITIAL_VALIDATION);
    latestResultRef.current = null;
  }, [
    currentStateSnapshot,
    latestResultRef,
    recordStateFeedback,
    setCollectionState,
    setDetailView,
    setResultView,
    setValidationView,
  ]);
}
