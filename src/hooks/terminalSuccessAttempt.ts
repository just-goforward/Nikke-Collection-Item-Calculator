import { useCallback } from "react";

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
          detailMessage: "대성공 시점이 기록되었습니다.",
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
          ? "대성공 시점을 알 수 없어 통계 전송은 생략했습니다. 보유 키트 수를 직접 수정해 주세요."
          : "대성공 시점을 알 수 없어 시도 분포 통계는 생략했습니다.",
        detailMessage: needsStockEdit
          ? "보유 키트 수를 실제 결과에 맞게 수정하면 계산이 다시 활성화됩니다."
          : "SR 15레벨은 최종 목표 상태입니다.",
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
