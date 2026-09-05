import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";
import { message } from "../i18n/locale";
import type { CollectionState, Stock } from "../types";
import type { DetailView, ResultView, StateChangeFeedback, ValidationView } from "../ui-types";
import {
  DEFAULT_STOCK_NOTICE,
  INITIAL_VALIDATION,
  type PendingStatsEvent,
  type SolverResult,
} from "./calculatorShared";
import type { ConvertApplyResult } from "./outcomeFlowTypes";
import { canApplyConversion, planConversion } from "./outcomeTransitionPlans";

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
  setPendingStatsEvent: (event: PendingStatsEvent | null) => void;
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
  setPendingStatsEvent,
  setResultView,
  setValidationView,
}: ConvertActionOptions) {
  return useCallback((): ConvertApplyResult | null => {
    const previousState = currentStateSnapshot();
    if (!canApplyConversion(previousState)) return null;
    const previousInput = latestResultRef.current?.input;
    const plan = planConversion(
      previousState,
      currentStockSnapshot(),
      pendingStatsEventRef.current,
      previousInput,
    );
    if (!plan) return null;
    if (plan.pendingEvent) setPendingStatsEvent(plan.pendingEvent);
    recordStateFeedback(previousState, plan.nextState);
    setCollectionState(plan.nextState, { maxLevelRender: false });
    setManualStockEditRequired(plan.hasPendingGreatSuccess);
    setResultView({
      type: "callout",
      reason: "converted",
      message: message("result.convertedToSr5"),
    });
    setDetailView({
      type: "empty",
      message: plan.hasPendingGreatSuccess
        ? DEFAULT_STOCK_NOTICE
        : message("result.calculateChanged"),
    });
    setValidationView(INITIAL_VALIDATION);
    latestResultRef.current = null;
    return plan.hasPendingGreatSuccess
      ? { needsStockEdit: true }
      : { needsStockEdit: false, nextInput: plan.nextInput };
  }, [
    currentStockSnapshot,
    currentStateSnapshot,
    latestResultRef,
    pendingStatsEventRef,
    recordStateFeedback,
    setCollectionState,
    setDetailView,
    setManualStockEditRequired,
    setPendingStatsEvent,
    setResultView,
    setValidationView,
  ]);
}
