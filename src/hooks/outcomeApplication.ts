import { useCallback } from "react";

import { convertState, transition } from "../solver/domain";
import { DEFAULT_STOCK_NOTICE, makeStatsEvent, stockPiecesForKit } from "./calculatorShared";
import { stockAfterKitUse } from "./outcomeFlowHelpers";
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
  setStockCountForKit,
}: Pick<
  OutcomeSharedOptions,
  | "currentStockSnapshot"
  | "latestResultRef"
  | "pendingStatsEventRef"
  | "queueStatsEvent"
  | "recordStateFeedback"
  | "setCollectionState"
  | "setManualStockEditRequired"
  | "setStockCountForKit"
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

      if (outcome === "success") {
        const nextState = run.success;
        const reachesConvertState = nextState.grade === "R" && nextState.level >= 15;
        const reachesFinalTarget = nextState.grade === "SR" && nextState.level >= 15;

        if (reachesConvertState) {
          const convertedState = convertState();
          pendingStatsEventRef.current = {
            start: startSnapshot,
            kit: best.firstAction,
            recommendedUses: run.count,
            stockBefore: stockBeforeSnapshot,
            resultState: convertedState,
          };
          setManualStockEditRequired(false);
          recordStateFeedback(startSnapshot, nextState);
          setCollectionState(nextState, { maxLevelRender: false });
          renderOutcomeApplied({
            best,
            run,
            nextState,
            outcome: "success",
            stockMessage: "SR 5로 교체한 뒤 보유 키트를 수정해야 계산이 진행됩니다.",
            detailMessage: "SR 5로 교체한 뒤 보유 키트를 실제 결과에 맞게 수정해 주세요.",
          });
          return { outcome: "success", needsStockEdit: false };
        }

        if (reachesFinalTarget) {
          pendingStatsEventRef.current = null;
          setManualStockEditRequired(false);
          recordStateFeedback(startSnapshot, nextState);
          setCollectionState(nextState, { maxLevelRender: false });
          renderOutcomeApplied({
            best,
            run,
            nextState,
            outcome: "success",
            stockMessage: "최종 단계에 도달했습니다.",
            detailMessage: "최종 단계에 도달했습니다.",
          });
          return { outcome: "success", needsStockEdit: false };
        }

        setManualStockEditRequired(true);
        pendingStatsEventRef.current = {
          start: startSnapshot,
          kit: best.firstAction,
          recommendedUses: run.count,
          stockBefore: stockBeforeSnapshot,
          resultState: { ...run.success },
        };
        recordStateFeedback(startSnapshot, nextState);
        setCollectionState(nextState, { maxLevelRender: false });
        renderOutcomeApplied({
          best,
          run,
          nextState,
          outcome: "success",
          stockMessage: DEFAULT_STOCK_NOTICE,
          detailMessage: "보유 키트 수를 실제 결과에 맞게 수정하면 계산이 다시 활성화됩니다.",
          preserveExistingResult: true,
        });
        return { outcome: "success", needsStockEdit: true };
      }

      const usedCount = run.count * 10;
      const stockAfter = stockAfterKitUse(currentStock, best.firstAction, beforeStock, usedCount);
      const nextState = run.fail;

      return {
        outcome: "fail",
        commit: () => {
          setStockCountForKit(best.firstAction, beforeStock - usedCount);
          recordStateFeedback(startSnapshot, nextState);
          setCollectionState(nextState, { maxLevelRender: false });
          queueStatsEvent(
            makeStatsEvent({
              start: startSnapshot,
              kit: best.firstAction,
              recommendedUses: run.count,
              outcome: "no_great_success",
              successAttempt: null,
              stockBefore: stockBeforeSnapshot,
              stockAfter,
              resultState: nextState,
            }),
          );
        },
        needsStockEdit: false,
        previousAction: { kit: best.firstAction, count: run.count },
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
      setStockCountForKit,
    ],
  );
}
