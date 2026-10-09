import { useCallback } from "react";

import { message } from "../i18n/locale";
import type { TerminalSuccessContext } from "./calculatorShared";
import { kitStockChangeMessage } from "./outcomeFlowHelpers";
import type { OutcomeRenderArgs, OutcomeSharedOptions } from "./outcomeFlowTypes";
import { planSuccessAttempt } from "./outcomeTransitionPlans";

type TerminalSuccessAttemptOptions = Pick<
  OutcomeSharedOptions,
  | "currentStockSnapshot"
  | "queueStatsEvent"
  | "recordStateFeedback"
  | "setCollectionState"
  | "setManualStockEditRequired"
  | "setPendingStatsEvent"
  | "setStockCountForKit"
> & {
  renderOutcomeApplied: (args: OutcomeRenderArgs) => void;
};

function successAttemptMessages(plan: { needsStockEdit: boolean; reachesConvertState: boolean }) {
  if (plan.reachesConvertState) {
    return {
      stockMessage: message("result.convertThenEdit"),
      detailMessage: message("result.convertThenEditDetail"),
    };
  }
  if (plan.needsStockEdit) {
    return {
      stockMessage: message("result.successUnknownEdit"),
      detailMessage: message("result.editStockToContinue"),
    };
  }
  return {
    stockMessage: message("result.successUnknownStats"),
    detailMessage: message("detail.finalTarget"),
  };
}

function applySuccessAttempt(
  context: TerminalSuccessContext,
  successAttempt: number | null,
  {
    currentStockSnapshot,
    queueStatsEvent,
    recordStateFeedback,
    renderOutcomeApplied,
    setCollectionState,
    setManualStockEditRequired,
    setPendingStatsEvent,
    setStockCountForKit,
  }: TerminalSuccessAttemptOptions,
  renderIntermediate: boolean,
) {
  const { best, beforeStock, run, startSnapshot } = context;
  const nextState = run.success;
  recordStateFeedback(startSnapshot, nextState);
  setCollectionState(nextState, { maxLevelRender: false });
  const plan = planSuccessAttempt(
    context,
    successAttempt,
    successAttempt ? currentStockSnapshot() : null,
  );

  if ("calculation" in plan) {
    setPendingStatsEvent(null);
    setManualStockEditRequired(false);
    setStockCountForKit(best.firstAction, plan.stockCountAfter);
    queueStatsEvent(plan.statsEvent);
    if (renderIntermediate) {
      renderOutcomeApplied({
        best,
        run,
        nextState,
        outcome: "success",
        stockMessage: kitStockChangeMessage(
          best.firstAction,
          beforeStock,
          plan.stockAfter[best.firstAction],
        ),
        detailMessage: message("result.successRecorded"),
      });
    }
    return plan.calculation;
  }

  setPendingStatsEvent(plan.pendingEvent);
  setManualStockEditRequired(plan.needsStockEdit);
  renderOutcomeApplied({
    best,
    run,
    nextState,
    outcome: "success",
    ...successAttemptMessages(plan),
    preserveExistingResult: plan.needsStockEdit,
  });
  return null;
}

export function useTerminalSuccessAttempt(options: TerminalSuccessAttemptOptions) {
  const {
    currentStockSnapshot,
    queueStatsEvent,
    recordStateFeedback,
    renderOutcomeApplied,
    setCollectionState,
    setManualStockEditRequired,
    setPendingStatsEvent,
    setStockCountForKit,
  } = options;
  return useCallback(
    (
      context: TerminalSuccessContext,
      successAttempt: number | null,
      behavior: { renderIntermediate?: boolean } = {},
    ) =>
      applySuccessAttempt(
        context,
        successAttempt,
        {
          currentStockSnapshot,
          queueStatsEvent,
          recordStateFeedback,
          renderOutcomeApplied,
          setCollectionState,
          setManualStockEditRequired,
          setPendingStatsEvent,
          setStockCountForKit,
        },
        behavior.renderIntermediate ?? true,
      ),
    [
      currentStockSnapshot,
      queueStatsEvent,
      recordStateFeedback,
      renderOutcomeApplied,
      setCollectionState,
      setManualStockEditRequired,
      setPendingStatsEvent,
      setStockCountForKit,
    ],
  );
}
