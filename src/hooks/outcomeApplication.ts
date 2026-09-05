import { useCallback } from "react";
import { message } from "../i18n/locale";
import type { SolverInput } from "../types";
import type { RecommendationAction } from "../ui-types";
import type { TerminalSuccessContext } from "./calculatorShared";
import { DEFAULT_STOCK_NOTICE } from "./calculatorShared";
import type {
  OutcomeApplyResult,
  OutcomeRenderArgs,
  OutcomeSharedOptions,
} from "./outcomeFlowTypes";
import {
  OUTCOME_PLAN_ATTEMPT,
  OUTCOME_PLAN_KNOWN,
  type PreparedOutcome,
  planFailedOutcome,
  planSuccessfulOutcome,
  prepareRecommendedOutcome,
} from "./outcomeTransitionPlans";

type OutcomeApplicationOptions = Pick<
  OutcomeSharedOptions,
  | "currentStockSnapshot"
  | "latestResultRef"
  | "queueStatsEvent"
  | "recordStateFeedback"
  | "setCollectionState"
  | "setManualStockEditRequired"
  | "setModal"
  | "setPendingStatsEvent"
  | "setStockCountForKit"
  | "terminalSuccessContextRef"
> & {
  applyKnownSuccessAttempt: (
    context: TerminalSuccessContext,
    successAttempt: number,
  ) => {
    nextInput: SolverInput;
    previousAction: RecommendationAction;
  };
  renderOutcomeApplied: (args: OutcomeRenderArgs) => void;
};

function prepareOutcome(options: OutcomeApplicationOptions) {
  return prepareRecommendedOutcome(options.latestResultRef.current, options.currentStockSnapshot);
}

function applySuccessfulOutcome(
  prepared: PreparedOutcome,
  options: OutcomeApplicationOptions,
): OutcomeApplyResult {
  const { best, beforeStock, run } = prepared;
  const plan = planSuccessfulOutcome(prepared);

  if (plan.kind === OUTCOME_PLAN_KNOWN) {
    return {
      outcome: "success",
      needsStockEdit: false,
      autoCalculation: options.applyKnownSuccessAttempt(plan.context, 1),
    };
  }

  if (plan.kind === OUTCOME_PLAN_ATTEMPT) {
    options.setPendingStatsEvent(null);
    options.setManualStockEditRequired(false);
    options.terminalSuccessContextRef.current = plan.context;
    options.setModal({
      open: true,
      maxAttempt: run.count,
      attempt: 1,
      kit: best.firstAction,
      beforeStock,
    });
    return { outcome: "success", needsStockEdit: false };
  }

  options.setManualStockEditRequired(true);
  options.setPendingStatsEvent(plan.pendingEvent);
  options.recordStateFeedback(plan.context.startSnapshot, plan.nextState);
  options.setCollectionState(plan.nextState, { maxLevelRender: false });
  options.renderOutcomeApplied({
    best,
    run,
    nextState: plan.nextState,
    outcome: "success",
    stockMessage: DEFAULT_STOCK_NOTICE,
    detailMessage: message("result.editStockToContinue"),
    preserveExistingResult: true,
  });
  return { outcome: "success", needsStockEdit: true };
}

function applyFailedOutcome(
  prepared: PreparedOutcome,
  options: OutcomeApplicationOptions,
): OutcomeApplyResult {
  const { best } = prepared;
  const plan = planFailedOutcome(prepared);

  options.setStockCountForKit(best.firstAction, plan.stockCountAfter);
  options.recordStateFeedback(prepared.startSnapshot, plan.nextState);
  options.setCollectionState(plan.nextState, { maxLevelRender: false });
  options.queueStatsEvent(plan.statsEvent);

  return {
    outcome: "fail",
    needsStockEdit: false,
    ...plan.calculation,
  };
}

export function useOutcomeApplication(options: OutcomeApplicationOptions) {
  const {
    applyKnownSuccessAttempt,
    currentStockSnapshot,
    latestResultRef,
    queueStatsEvent,
    recordStateFeedback,
    renderOutcomeApplied,
    setCollectionState,
    setManualStockEditRequired,
    setModal,
    setPendingStatsEvent,
    setStockCountForKit,
    terminalSuccessContextRef,
  } = options;
  return useCallback(
    (outcome: "success" | "fail"): OutcomeApplyResult => {
      const currentOptions: OutcomeApplicationOptions = {
        applyKnownSuccessAttempt,
        currentStockSnapshot,
        latestResultRef,
        queueStatsEvent,
        recordStateFeedback,
        renderOutcomeApplied,
        setCollectionState,
        setManualStockEditRequired,
        setModal,
        setPendingStatsEvent,
        setStockCountForKit,
        terminalSuccessContextRef,
      };
      const prepared = prepareOutcome(currentOptions);
      if (!prepared) return null;
      return outcome === "success"
        ? applySuccessfulOutcome(prepared, currentOptions)
        : applyFailedOutcome(prepared, currentOptions);
    },
    [
      applyKnownSuccessAttempt,
      currentStockSnapshot,
      latestResultRef,
      queueStatsEvent,
      recordStateFeedback,
      renderOutcomeApplied,
      setCollectionState,
      setManualStockEditRequired,
      setModal,
      setPendingStatsEvent,
      setStockCountForKit,
      terminalSuccessContextRef,
    ],
  );
}
