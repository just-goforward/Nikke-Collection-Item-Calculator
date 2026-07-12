import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";
import { message } from "../i18n/locale";
import { convertState } from "../solver/domain";
import type { CollectionState } from "../types";
import type { DetailView, ResultView, StateChangeFeedback, ValidationView } from "../ui-types";
import {
  DEFAULT_STOCK_NOTICE,
  INITIAL_VALIDATION,
  type PendingStatsEvent,
  type SolverResult,
} from "./calculatorShared";

type ConvertActionOptions = {
  currentStateSnapshot: () => CollectionState;
  latestResultRef: RefObject<SolverResult | null>;
  pendingStatsEventRef: RefObject<PendingStatsEvent | null>;
  recordStateFeedback: (from: StateChangeFeedback["from"], to: StateChangeFeedback["to"]) => void;
  setCollectionState: (
    next: CollectionState,
    options?: { maxLevelRender?: boolean; markChanged?: boolean },
  ) => void;
  setDetailView: Dispatch<SetStateAction<DetailView>>;
  setManualStockEditRequired: (required: boolean) => void;
  setResultView: Dispatch<SetStateAction<ResultView>>;
  setValidationView: Dispatch<SetStateAction<ValidationView>>;
};

export function useConvertAction({
  currentStateSnapshot,
  latestResultRef,
  pendingStatsEventRef,
  recordStateFeedback,
  setCollectionState,
  setDetailView,
  setManualStockEditRequired,
  setResultView,
  setValidationView,
}: ConvertActionOptions) {
  return useCallback(() => {
    const previousState = currentStateSnapshot();
    const nextState = convertState() as CollectionState;
    const hasPendingGreatSuccess = pendingStatsEventRef.current !== null;
    if (pendingStatsEventRef.current) {
      pendingStatsEventRef.current = {
        ...pendingStatsEventRef.current,
        resultState: nextState,
      };
    }
    recordStateFeedback(previousState, nextState);
    setCollectionState(nextState, { maxLevelRender: false });
    setManualStockEditRequired(hasPendingGreatSuccess);
    setResultView({
      type: "callout",
      reason: "converted",
      message: message("result.convertedToSr5"),
    });
    setDetailView({
      type: "empty",
      message: hasPendingGreatSuccess ? DEFAULT_STOCK_NOTICE : message("result.calculateChanged"),
    });
    setValidationView(INITIAL_VALIDATION);
    latestResultRef.current = null;
    return { needsStockEdit: hasPendingGreatSuccess };
  }, [
    currentStateSnapshot,
    latestResultRef,
    pendingStatsEventRef,
    recordStateFeedback,
    setCollectionState,
    setDetailView,
    setManualStockEditRequired,
    setResultView,
    setValidationView,
  ]);
}
