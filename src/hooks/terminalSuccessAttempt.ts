import { useCallback } from "react";

import { message } from "../i18n/locale";
import { convertState } from "../solver/domain";
import {
  makeStatsEvent,
  type PendingStatsEvent,
  type TerminalSuccessContext,
} from "./calculatorShared";
import { kitStockChangeMessage, stockAfterKitUse } from "./outcomeFlowHelpers";
import type { OutcomeRenderArgs, OutcomeSharedOptions } from "./outcomeFlowTypes";

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
  const { best, beforeStock, input, run, startSnapshot, stockBeforeSnapshot } = context;
  const nextState = run.success;
  recordStateFeedback(startSnapshot, nextState);
  setCollectionState(nextState, { maxLevelRender: false });

  if (successAttempt) {
    const usedCount = successAttempt * 10;
    const stockAfter = stockAfterKitUse(
      currentStockSnapshot(),
      best.firstAction,
      beforeStock,
      usedCount,
    );
    setPendingStatsEvent(null);
    setManualStockEditRequired(false);
    setStockCountForKit(best.firstAction, beforeStock - usedCount);
    queueStatsEvent(
      makeStatsEvent({
        start: startSnapshot,
        kit: best.firstAction,
        recommendedUses: run.count,
        outcome: "great_success",
        successAttempt,
        stockBefore: stockBeforeSnapshot,
        stockAfter,
        resultState: nextState,
      }),
    );
    if (renderIntermediate) {
      renderOutcomeApplied({
        best,
        run,
        nextState,
        outcome: "success",
        stockMessage: kitStockChangeMessage(
          best.firstAction,
          beforeStock,
          stockAfter[best.firstAction],
        ),
        detailMessage: message("result.successRecorded"),
      });
    }
    return {
      nextInput: {
        start: nextState,
        stock: stockAfter,
        ...(input.strategy ? { strategy: input.strategy } : {}),
      },
      previousAction: { kit: best.firstAction, count: run.count },
    };
  }

  const reachesConvertState = nextState.grade === "R" && nextState.level >= 15;
  const reachesFinalTarget = nextState.grade === "SR" && nextState.level >= 15;
  const needsStockEditNow = !reachesConvertState && !reachesFinalTarget;
  if (!reachesFinalTarget) {
    const resultState = reachesConvertState ? convertState() : { ...nextState };
    const pendingEvent: PendingStatsEvent = {
      start: startSnapshot,
      kit: best.firstAction,
      recommendedUses: run.count,
      stockBefore: stockBeforeSnapshot,
      resultState,
    };
    setPendingStatsEvent(pendingEvent);
  } else {
    setPendingStatsEvent(null);
  }
  setManualStockEditRequired(needsStockEditNow);
  renderOutcomeApplied({
    best,
    run,
    nextState,
    outcome: "success",
    stockMessage: reachesConvertState
      ? message("result.convertThenEdit")
      : needsStockEditNow
        ? message("result.successUnknownEdit")
        : message("result.successUnknownStats"),
    detailMessage: reachesConvertState
      ? message("result.convertThenEditDetail")
      : needsStockEditNow
        ? message("result.editStockToContinue")
        : message("detail.finalTarget"),
    preserveExistingResult: needsStockEditNow,
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
