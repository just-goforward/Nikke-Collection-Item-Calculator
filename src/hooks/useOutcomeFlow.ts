import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react";

import { formatInteger } from "../format";
import type { StatsSubmissionEvent } from "../lib/statsSubmissionQueue";
import { convertState, describeState, KIT_META, transition } from "../solver";
import type { CollectionState, Kit, SolverInput, Stock } from "../types";
import type {
  DetailView,
  ResultView,
  StateChangeFeedback,
  SuccessAttemptModalState,
  ValidationView,
} from "../ui-types";
import {
  INITIAL_VALIDATION,
  makeStatsEvent,
  type PendingStatsEvent,
  type RecommendedRun,
  type SolverBest,
  type SolverResult,
  stockPiecesForKit,
  type TerminalSuccessContext,
} from "./calculatorShared";

type UseOutcomeFlowOptions = {
  latestResultRef: RefObject<SolverResult | null>;
  pendingStatsEventRef: RefObject<PendingStatsEvent | null>;
  currentStockSnapshot: () => Stock;
  setCollectionState: (
    next: CollectionState,
    options?: { maxLevelRender?: boolean; markChanged?: boolean },
  ) => void;
  setStockCountForKit: (kit: Kit, value: number) => void;
  setManualStockEditRequired: (required: boolean) => void;
  setResultView: Dispatch<SetStateAction<ResultView>>;
  setDetailView: Dispatch<SetStateAction<DetailView>>;
  setValidationView: Dispatch<SetStateAction<ValidationView>>;
  queueStatsEvent: (event: StatsSubmissionEvent) => void;
  currentStateSnapshot: () => CollectionState;
  recordStateFeedback: (from: StateChangeFeedback["from"], to: StateChangeFeedback["to"]) => void;
};

export type OutcomeApplyResult =
  | {
      outcome: "fail";
      nextInput: SolverInput;
    }
  | {
      outcome: "success";
    }
  | null;

export function useOutcomeFlow({
  latestResultRef,
  pendingStatsEventRef,
  currentStockSnapshot,
  setCollectionState,
  setStockCountForKit,
  setManualStockEditRequired,
  setResultView,
  setDetailView,
  setValidationView,
  queueStatsEvent,
  currentStateSnapshot,
  recordStateFeedback,
}: UseOutcomeFlowOptions) {
  const [modal, setModal] = useState<SuccessAttemptModalState>({
    open: false,
    maxAttempt: 1,
    attempt: 1,
  });
  const terminalSuccessContextRef = useRef<TerminalSuccessContext | null>(null);

  const renderOutcomeApplied = useCallback(
    ({
      best,
      run,
      nextState,
      outcomeLabel,
      stockMessage,
      detailMessage,
    }: {
      best: SolverBest;
      run: RecommendedRun;
      nextState: CollectionState;
      outcomeLabel: string;
      stockMessage: string;
      detailMessage: string;
    }) => {
      setResultView({
        type: "outcome",
        kit: best.firstAction,
        count: run.count,
        outcomeLabel,
        stateText: describeState(nextState),
        stockMessage,
        showConvertRecommendation: nextState.grade === "R" && nextState.level >= 15,
      });
      setDetailView({ type: "empty", message: detailMessage });
      setValidationView(INITIAL_VALIDATION);
      latestResultRef.current = null;
    },
    [latestResultRef, setDetailView, setResultView, setValidationView],
  );

  const applyTerminalSuccessAttempt = useCallback(
    (context: TerminalSuccessContext, successAttempt: number | null) => {
      const { best, run, startSnapshot, stockBeforeSnapshot, beforeStock } = context;
      const nextState = run.success;
      recordStateFeedback(startSnapshot, nextState);
      setCollectionState(nextState, { maxLevelRender: false });

      if (successAttempt) {
        const usedCount = successAttempt * 10;
        setStockCountForKit(best.firstAction, beforeStock - usedCount);
        const stockAfter = {
          ...currentStockSnapshot(),
          [best.firstAction]: Math.max(0, beforeStock - usedCount),
        };
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
          outcomeLabel: "대성공 O",
          stockMessage: `${KIT_META[best.firstAction].label} 보유량은 ${formatInteger(beforeStock)}개에서 ${formatInteger(
            Math.max(0, beforeStock - usedCount),
          )}개가 되었습니다.`,
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
        outcomeLabel: "대성공 O",
        stockMessage: needsStockEdit
          ? "대성공 시점을 알 수 없어 통계 전송은 생략했습니다. 보유 키트 수를 직접 수정해 주세요."
          : "대성공 시점을 알 수 없어 시도 분포 통계는 생략했습니다.",
        detailMessage: needsStockEdit
          ? "보유 키트 수를 실제 결과에 맞게 수정하면 계산이 다시 활성화됩니다."
          : "SR 15레벨은 최종 목표 상태입니다.",
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

  const applyOutcome = useCallback(
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
      const terminalMultiSuccess =
        outcome === "success" && run.count > 1 && run.success.level >= 15;
      if (terminalMultiSuccess) {
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
        ? {
            ...currentStock,
            [best.firstAction]: Math.max(0, beforeStock - usedCount),
          }
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
          ? `${KIT_META[best.firstAction].label} 보유량은 ${formatInteger(beforeStock)}개에서 ${formatInteger(
              Math.max(0, beforeStock - usedCount),
            )}개가 되었습니다.`
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
          strategy: latest.input.strategy,
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

  const applyConvert = useCallback(() => {
    const previousState = currentStateSnapshot();
    const nextState = convertState() as CollectionState;
    recordStateFeedback(previousState, nextState);
    setCollectionState(nextState, { maxLevelRender: false });
    setResultView({
      type: "callout",
      message: `SR 등급으로 교체했습니다. 현재 상태는 ${describeState(nextState)}입니다.`,
    });
    setDetailView({ type: "empty", message: "변경된 상태로 다시 계산하세요." });
    setValidationView(INITIAL_VALIDATION);
    latestResultRef.current = null;
  }, [
    currentStateSnapshot,
    latestResultRef,
    recordStateFeedback,
    setCollectionState,
    setDetailView,
    setResultView,
    setValidationView,
  ]);

  const submitSuccessAttempt = useCallback(
    (successAttempt: number | null) => {
      const context = terminalSuccessContextRef.current;
      terminalSuccessContextRef.current = null;
      setModal((current) => ({ ...current, open: false }));
      if (!context) return;
      applyTerminalSuccessAttempt(context, successAttempt);
    },
    [applyTerminalSuccessAttempt],
  );

  const setModalAttempt = useCallback((attempt: number) => {
    setModal((current) => ({
      ...current,
      attempt: Math.min(current.maxAttempt, Math.max(1, Math.trunc(Number(attempt) || 1))),
    }));
  }, []);

  const resetOutcomeFlow = useCallback(() => {
    terminalSuccessContextRef.current = null;
    setModal({ open: false, maxAttempt: 1, attempt: 1 });
  }, []);

  return {
    modal,
    applyOutcome,
    applyConvert,
    setModalAttempt,
    submitSuccessAttempt,
    resetOutcomeFlow,
  };
}
