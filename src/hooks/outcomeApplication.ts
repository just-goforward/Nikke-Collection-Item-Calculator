import { useCallback } from "react";
import { message } from "../i18n/locale";
import { transition } from "../solver/domain";
import type { SolverInput } from "../types";
import type { RecommendationAction } from "../ui-types";
import type { TerminalSuccessContext } from "./calculatorShared";
import { DEFAULT_STOCK_NOTICE, makeStatsEvent, stockPiecesForKit } from "./calculatorShared";
import { stockAfterKitUse } from "./outcomeFlowHelpers";
import type {
  OutcomeApplyResult,
  OutcomeRenderArgs,
  OutcomeSharedOptions,
} from "./outcomeFlowTypes";

type OutcomeApplicationOptions = Pick<
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
  const latest = options.latestResultRef.current;
  if (!latest?.possible || !latest.best || !latest.input) return null;
  const best = latest.best;
  const edge = transition(latest.input.start, best.firstAction);
  const run = best.run || { count: 1, success: edge.success, fail: edge.fail };
  const currentStock = options.currentStockSnapshot();
  return {
    beforeStock: stockPiecesForKit(currentStock, best.firstAction),
    best,
    currentStock,
    input: latest.input,
    latest,
    run,
    startSnapshot: { ...latest.input.start },
    stockBeforeSnapshot: { ...latest.input.stock },
  };
}

type PreparedOutcome = NonNullable<ReturnType<typeof prepareOutcome>>;

function applySuccessfulOutcome(
  prepared: PreparedOutcome,
  options: OutcomeApplicationOptions,
): OutcomeApplyResult {
  const { best, beforeStock, input, run, startSnapshot, stockBeforeSnapshot } = prepared;
  const nextState = run.success;
  const reachesConvertState = nextState.grade === "R" && nextState.level >= 15;
  const reachesFinalTarget = nextState.grade === "SR" && nextState.level >= 15;
  const successContext: TerminalSuccessContext = {
    best,
    beforeStock,
    input,
    run,
    startSnapshot,
    stockBeforeSnapshot,
  };

  if (run.count === 1) {
    return {
      outcome: "success",
      needsStockEdit: false,
      autoCalculation: options.applyKnownSuccessAttempt(successContext, 1),
    };
  }

  if (reachesConvertState || reachesFinalTarget) {
    options.pendingStatsEventRef.current = null;
    options.setManualStockEditRequired(false);
    options.terminalSuccessContextRef.current = successContext;
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
  options.pendingStatsEventRef.current = {
    start: startSnapshot,
    kit: best.firstAction,
    recommendedUses: run.count,
    stockBefore: stockBeforeSnapshot,
    resultState: { ...run.success },
  };
  options.recordStateFeedback(startSnapshot, nextState);
  options.setCollectionState(nextState, { maxLevelRender: false });
  options.renderOutcomeApplied({
    best,
    run,
    nextState,
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
  const { beforeStock, best, currentStock, input, run, startSnapshot, stockBeforeSnapshot } =
    prepared;
  const usedCount = run.count * 10;
  const stockAfter = stockAfterKitUse(currentStock, best.firstAction, beforeStock, usedCount);
  const nextState = run.fail;

  return {
    outcome: "fail",
    commit: () => {
      options.setStockCountForKit(best.firstAction, beforeStock - usedCount);
      options.recordStateFeedback(startSnapshot, nextState);
      options.setCollectionState(nextState, { maxLevelRender: false });
      options.queueStatsEvent(
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
      ...(input.strategy ? { strategy: input.strategy } : {}),
    },
  };
}

export function useOutcomeApplication(options: OutcomeApplicationOptions) {
  const {
    applyKnownSuccessAttempt,
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
  } = options;
  return useCallback(
    (outcome: "success" | "fail"): OutcomeApplyResult => {
      const currentOptions: OutcomeApplicationOptions = {
        applyKnownSuccessAttempt,
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
