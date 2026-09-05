import { convertState, transition } from "../solver/domain";
import type { CollectionState, SolverInput, Stock } from "../types";
import type { RecommendationAction } from "../ui-types";
import {
  makeStatsEvent,
  type PendingStatsEvent,
  type RecommendedRun,
  type SolverBest,
  type SolverResult,
  stockPiecesForKit,
  type TerminalSuccessContext,
} from "./calculatorShared";
import { stockAfterKitUse } from "./outcomeFlowHelpers";

export type PreparedOutcome = {
  beforeStock: number;
  best: SolverBest;
  currentStock: Stock;
  input: SolverInput;
  run: RecommendedRun;
  startSnapshot: CollectionState;
  stockBeforeSnapshot: Stock;
};

type CalculationPlan = {
  nextInput: SolverInput;
  previousAction: RecommendationAction;
};

export function prepareRecommendedOutcome(
  latest: SolverResult | null,
  currentStockSnapshot: () => Stock,
): PreparedOutcome | null {
  if (!latest?.possible || !latest.best || !latest.input) return null;
  const currentStock = currentStockSnapshot();
  const edge = transition(latest.input.start, latest.best.firstAction);
  const run = latest.best.run || { count: 1, success: edge.success, fail: edge.fail };
  return {
    beforeStock: stockPiecesForKit(currentStock, latest.best.firstAction),
    best: latest.best,
    currentStock,
    input: latest.input,
    run,
    startSnapshot: { ...latest.input.start },
    stockBeforeSnapshot: { ...latest.input.stock },
  };
}

export const OUTCOME_PLAN_KNOWN = 0 as const;
export const OUTCOME_PLAN_ATTEMPT = 1 as const;
export const OUTCOME_PLAN_STOCK = 2 as const;

export type SuccessfulOutcomePlan =
  | { kind: typeof OUTCOME_PLAN_KNOWN; context: TerminalSuccessContext }
  | { kind: typeof OUTCOME_PLAN_ATTEMPT; context: TerminalSuccessContext }
  | {
      kind: typeof OUTCOME_PLAN_STOCK;
      context: TerminalSuccessContext;
      nextState: CollectionState;
      pendingEvent: PendingStatsEvent;
    };

function terminalSuccessKind(nextState: CollectionState): 0 | 1 | 2 {
  if (nextState.level < 15) return 0;
  if (nextState.grade === "R") return 1;
  return nextState.grade === "SR" ? 2 : 0;
}

export function planSuccessfulOutcome(prepared: PreparedOutcome): SuccessfulOutcomePlan {
  const context: TerminalSuccessContext = {
    best: prepared.best,
    beforeStock: prepared.beforeStock,
    input: prepared.input,
    run: prepared.run,
    startSnapshot: prepared.startSnapshot,
    stockBeforeSnapshot: prepared.stockBeforeSnapshot,
  };
  if (prepared.run.count === 1) return { kind: OUTCOME_PLAN_KNOWN, context };

  const nextState = prepared.run.success;
  if (terminalSuccessKind(nextState)) return { kind: OUTCOME_PLAN_ATTEMPT, context };

  return {
    kind: OUTCOME_PLAN_STOCK,
    context,
    nextState,
    pendingEvent: {
      start: prepared.startSnapshot,
      kit: prepared.best.firstAction,
      recommendedUses: prepared.run.count,
      stockBefore: prepared.stockBeforeSnapshot,
      resultState: { ...nextState },
    },
  };
}

export function planFailedOutcome(prepared: PreparedOutcome) {
  const usedCount = prepared.run.count * 10;
  const stockAfter = stockAfterKitUse(
    prepared.currentStock,
    prepared.best.firstAction,
    prepared.beforeStock,
    usedCount,
  );
  return {
    nextState: prepared.run.fail,
    stockAfter,
    stockCountAfter: prepared.beforeStock - usedCount,
    statsEvent: makeStatsEvent({
      start: prepared.startSnapshot,
      kit: prepared.best.firstAction,
      recommendedUses: prepared.run.count,
      outcome: "no_great_success",
      successAttempt: null,
      stockBefore: prepared.stockBeforeSnapshot,
      stockAfter,
      resultState: prepared.run.fail,
    }),
    calculation: {
      nextInput: {
        start: prepared.run.fail,
        stock: stockAfter,
        ...(prepared.input.strategy ? { strategy: prepared.input.strategy } : {}),
      },
      previousAction: { kit: prepared.best.firstAction, count: prepared.run.count },
    },
  };
}

export type SuccessAttemptPlan =
  | {
      stockAfter: Stock;
      stockCountAfter: number;
      statsEvent: ReturnType<typeof makeStatsEvent>;
      calculation: CalculationPlan;
    }
  | {
      reachesConvertState: boolean;
      reachesFinalTarget: boolean;
      needsStockEdit: boolean;
      pendingEvent: PendingStatsEvent | null;
    };

export function planSuccessAttempt(
  context: TerminalSuccessContext,
  successAttempt: number | null,
  currentStock: Stock | null,
): SuccessAttemptPlan {
  if (successAttempt) {
    if (!currentStock) throw new Error("Missing stock snapshot.");
    const usedCount = successAttempt * 10;
    const stockAfter = stockAfterKitUse(
      currentStock,
      context.best.firstAction,
      context.beforeStock,
      usedCount,
    );
    return {
      stockAfter,
      stockCountAfter: context.beforeStock - usedCount,
      statsEvent: makeStatsEvent({
        start: context.startSnapshot,
        kit: context.best.firstAction,
        recommendedUses: context.run.count,
        outcome: "great_success",
        successAttempt,
        stockBefore: context.stockBeforeSnapshot,
        stockAfter,
        resultState: context.run.success,
      }),
      calculation: {
        nextInput: {
          start: context.run.success,
          stock: stockAfter,
          ...(context.input.strategy ? { strategy: context.input.strategy } : {}),
        },
        previousAction: { kit: context.best.firstAction, count: context.run.count },
      },
    };
  }

  const nextState = context.run.success;
  const terminalKind = terminalSuccessKind(nextState);
  const reachesConvertState = terminalKind === 1;
  const reachesFinalTarget = terminalKind === 2;
  const needsStockEdit = !reachesConvertState && !reachesFinalTarget;
  const pendingEvent = reachesFinalTarget
    ? null
    : {
        start: context.startSnapshot,
        kit: context.best.firstAction,
        recommendedUses: context.run.count,
        stockBefore: context.stockBeforeSnapshot,
        resultState: reachesConvertState ? convertState() : { ...nextState },
      };
  return {
    reachesConvertState,
    reachesFinalTarget,
    needsStockEdit,
    pendingEvent,
  };
}

export function canApplyConversion(state: CollectionState) {
  return state.grade === "R" && state.level >= 15;
}

export function planConversion(
  previousState: CollectionState,
  currentStock: Stock,
  pendingEvent: PendingStatsEvent | null,
  previousInput: SolverInput | undefined,
) {
  if (!canApplyConversion(previousState)) return null;
  const nextState = convertState();
  const hasPendingGreatSuccess = pendingEvent !== null;
  return {
    nextState,
    hasPendingGreatSuccess,
    pendingEvent: pendingEvent ? { ...pendingEvent, resultState: nextState } : null,
    nextInput: {
      start: nextState,
      stock: currentStock,
      ...(previousInput?.strategy ? { strategy: previousInput.strategy } : {}),
    },
  };
}
