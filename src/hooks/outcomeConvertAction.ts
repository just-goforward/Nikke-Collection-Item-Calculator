import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";
import { message } from "../i18n/locale";
import { convertState } from "../solver/domain";
import type { CollectionState, Stock } from "../types";
import type { DetailView, ResultView, StateChangeFeedback, ValidationView } from "../ui-types";
import {
  DEFAULT_STOCK_NOTICE,
  INITIAL_VALIDATION,
  type PendingStatsEvent,
  type SolverResult,
} from "./calculatorShared";
import type { ConvertApplyResult } from "./outcomeFlowTypes";

type ConvertActionOptions = {
  currentStockSnapshot: () => Stock;
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
  currentStockSnapshot,
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
  return useCallback((): ConvertApplyResult => {
    const previousState = currentStateSnapshot();
    const nextState = convertState() as CollectionState;
    const hasPendingGreatSuccess = pendingStatsEventRef.current !== null;
    const previousInput = latestResultRef.current?.input;
    const nextInput = {
      start: nextState,
      stock: currentStockSnapshot(),
      ...(previousInput?.strategy ? { strategy: previousInput.strategy } : {}),
    };
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
    return hasPendingGreatSuccess ? { needsStockEdit: true } : { needsStockEdit: false, nextInput };
  }, [
    currentStockSnapshot,
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
