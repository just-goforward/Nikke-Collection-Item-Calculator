import { useCallback } from "react";

import { transition } from "../solver/domain";
import { makeStatsEvent, stockPiecesForKit } from "./calculatorShared";
import { kitStockChangeMessage, stockAfterKitUse } from "./outcomeFlowHelpers";
import type {
  OutcomeApplyResult,
  OutcomeRenderArgs,
  OutcomeSharedOptions,
} from "./outcomeFlowTypes";

export function useOutcomeApplication({
  currentStockSnapshot,
  latestResultRef,
  pendingStatsEventRef,
  queueStatsEvent,
  recordStateFeedback,
  renderOutcomeApplied,
  setCollectionState,
  setManualStockEditRequired,
  setModal,
  setStockCountForKit,
  terminalSuccessContextRef,
}: Pick<
  OutcomeSharedOptions,
  | "currentStockSnapshot"
  | "latestResultRef"
  | "pendingStatsEventRef"
  | "queueStatsEvent"
  | "recordStateFeedback"
  | "setCollectionState"
  | "setManualStockEditRequired"
  | "setModal"
  | "setStockCountForKit"
  | "terminalSuccessContextRef"
> & {
  renderOutcomeApplied: (args: OutcomeRenderArgs) => void;
}) {
  return useCallback(
    (outcome: "success" | "fail"): OutcomeApplyResult => {
      const latest = latestResultRef.current;
      if (!latest?.possible || !latest.best || !latest.input) return null;
      const best = latest.best;
      const edge = transition(latest.input.start, best.firstAction);
      const run = best.run || { count: 1, success: edge.success, fail: edge.fail };
      const startSnapshot = { ...latest.input.start };
      const stockBeforeSnapshot = { ...latest.input.stock };
      const currentStock = currentStockSnapshot();
      const beforeStock = stockPiecesForKit(currentStock, best.firstAction);
      if (outcome === "success" && run.count > 1 && run.success.level >= 15) {
        terminalSuccessContextRef.current = {
          best,
          run,
          startSnapshot,
          stockBeforeSnapshot,
          beforeStock,
        };
        setModal({ open: true, maxAttempt: run.count, attempt: 1 });
        return null;
      }

      const exactStockChange = outcome !== "success" || run.count === 1;
      const usedCount = exactStockChange ? run.count * 10 : 0;
      const stockAfter = exactStockChange
        ? stockAfterKitUse(currentStock, best.firstAction, beforeStock, usedCount)
        : currentStock;
      if (exactStockChange) setStockCountForKit(best.firstAction, beforeStock - usedCount);
      if (!exactStockChange) {
        setManualStockEditRequired(true);
        pendingStatsEventRef.current = {
          start: startSnapshot,
          kit: best.firstAction,
          recommendedUses: run.count,
          stockBefore: stockBeforeSnapshot,
          resultState: { ...run.success },
        };
      }

      const nextState = outcome === "success" ? run.success : run.fail;
      recordStateFeedback(startSnapshot, nextState);
      setCollectionState(nextState, { maxLevelRender: false });
      if (exactStockChange) {
        queueStatsEvent(
          makeStatsEvent({
            start: startSnapshot,
            kit: best.firstAction,
            recommendedUses: run.count,
            outcome: outcome === "success" ? "great_success" : "no_great_success",
            successAttempt: outcome === "success" ? 1 : null,
            stockBefore: stockBeforeSnapshot,
            stockAfter,
            resultState: nextState,
          }),
        );
      }

      renderOutcomeApplied({
        best,
        run,
        nextState,
        outcomeLabel: outcome === "success" ? "대성공 O" : "대성공 X",
        stockMessage: exactStockChange
          ? kitStockChangeMessage(best.firstAction, beforeStock, stockAfter[best.firstAction])
          : "다회 사용 중 대성공 발생 시점이 불명확하므로 보유 키트 수를 직접 수정해야 합니다. 수정 전까지 계산은 잠깁니다.",
        detailMessage: exactStockChange
          ? "변경된 상태로 다시 계산하세요."
          : "보유 키트 수를 실제 결과에 맞게 수정하면 계산이 다시 활성화됩니다.",
      });
      if (outcome !== "fail") return { outcome: "success" };
      return {
        outcome: "fail",
        nextInput: {
          start: nextState,
          stock: stockAfter,
          ...(latest.input.strategy ? { strategy: latest.input.strategy } : {}),
        },
      };
    },
    [
      currentStockSnapshot,
      latestResultRef,
      pendingStatsEventRef,
      queueStatsEvent,
      recordStateFeedback,
      renderOutcomeApplied,
      setCollectionState,
      setManualStockEditRequired,
      setModal,
      setStockCountForKit,
      terminalSuccessContextRef,
    ],
  );
}
