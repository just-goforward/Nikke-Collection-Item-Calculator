import { useCallback } from "react";

import { message } from "../i18n/locale";
import { makeStatsEvent, type TerminalSuccessContext } from "./calculatorShared";
import { kitStockChangeMessage, stockAfterKitUse } from "./outcomeFlowHelpers";
import type { OutcomeRenderArgs, OutcomeSharedOptions } from "./outcomeFlowTypes";

export function useTerminalSuccessAttempt({
  currentStockSnapshot,
  queueStatsEvent,
  recordStateFeedback,
  renderOutcomeApplied,
  setCollectionState,
  setManualStockEditRequired,
  setStockCountForKit,
}: Pick<
  OutcomeSharedOptions,
  | "currentStockSnapshot"
  | "queueStatsEvent"
  | "recordStateFeedback"
  | "setCollectionState"
  | "setManualStockEditRequired"
  | "setStockCountForKit"
> & {
  renderOutcomeApplied: (args: OutcomeRenderArgs) => void;
}) {
  return useCallback(
    (context: TerminalSuccessContext, successAttempt: number | null) => {
      const { best, beforeStock, run, startSnapshot, stockBeforeSnapshot } = context;
      const nextState = run.success;
      recordStateFeedback(startSnapshot, nextState);
      setCollectionState(nextState, { maxLevelRender: false });

      if (successAttempt) {
        const usedCount = successAttempt * 10;
        setStockCountForKit(best.firstAction, beforeStock - usedCount);
        const stockAfter = stockAfterKitUse(
          currentStockSnapshot(),
          best.firstAction,
          beforeStock,
          usedCount,
        );
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
        return;
      }

      const needsStockEdit = nextState.grade !== "SR" || nextState.level < 15;
      setManualStockEditRequired(needsStockEdit);
      renderOutcomeApplied({
        best,
        run,
        nextState,
        outcome: "success",
        stockMessage: needsStockEdit
          ? message("result.successUnknownEdit")
          : message("result.successUnknownStats"),
        detailMessage: needsStockEdit
          ? message("result.editStockToContinue")
          : message("detail.finalTarget"),
        preserveExistingResult: needsStockEdit,
      });
    },
    [
      currentStockSnapshot,
      queueStatsEvent,
      recordStateFeedback,
      renderOutcomeApplied,
      setCollectionState,
      setManualStockEditRequired,
      setStockCountForKit,
    ],
  );
}
