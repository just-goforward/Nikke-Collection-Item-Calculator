import { type Dispatch, type SetStateAction, useCallback } from "react";

import type { StatsSubmissionEvent } from "../lib/statsSubmissionQueue";
import type { SolverInput } from "../types";
import type { DetailView, LoadingView, RecommendationAction, ResultView } from "../ui-types";
import { makeSolverDiagnosticEvent } from "./calculatorDiagnostics";
import {
  DEFAULT_LOADING_TEXT,
  KIT_KEYS,
  makeStatsEvent,
  type PendingStatsEvent,
  type SolverResult,
  sameState,
} from "./calculatorShared";
import type { OutcomeApplyResult } from "./outcomeFlowTypes";

type MutableRef<T> = { current: T };

type SolveFlowOptions = {
  applyOutcome: (outcome: "success" | "fail") => OutcomeApplyResult;
  collectInput: () => SolverInput;
  currentStateSnapshot: () => SolverInput["start"];
  latestResultRef: MutableRef<SolverResult | null>;
  pendingStatsEventRef: MutableRef<PendingStatsEvent | null>;
  queueStatsEvent: (event: StatsSubmissionEvent) => void;
  renderResult: (result: SolverResult, previousAction?: RecommendationAction | null) => void;
  setCalculateBusy: (busy: boolean) => void;
  setDetailView: Dispatch<SetStateAction<DetailView>>;
  setLoading: Dispatch<SetStateAction<LoadingView>>;
  setResultView: Dispatch<SetStateAction<ResultView>>;
  solveBestAvailable: (input: SolverInput) => Promise<SolverResult>;
};

function recommendationFromResult(result: SolverResult | null): RecommendationAction | null {
  if (!result?.possible || !result.best) return null;
  return {
    kit: result.best.firstAction,
    count: result.best.run?.count || 1,
  };
}

function pendingStatsEventFromInput({
  currentStateSnapshot,
  input,
  pendingStatsEventRef,
}: {
  currentStateSnapshot: () => SolverInput["start"];
  input: SolverInput;
  pendingStatsEventRef: MutableRef<PendingStatsEvent | null>;
}) {
  const pending = pendingStatsEventRef.current;
  if (!pending) return null;
  pendingStatsEventRef.current = null;

  if (!sameState(currentStateSnapshot(), pending.resultState)) return null;
  const before = pending.stockBefore;
  const after = input.stock;
  const usedKits = before[pending.kit] - after[pending.kit];
  const successAttempt = usedKits / 10;
  const otherChanged = KIT_KEYS.some((kit) => kit !== pending.kit && before[kit] !== after[kit]);
  const valid =
    !otherChanged &&
    Number.isInteger(successAttempt) &&
    successAttempt >= 1 &&
    successAttempt <= pending.recommendedUses &&
    usedKits > 0;
  if (!valid) return null;
  return makeStatsEvent({
    start: pending.start,
    kit: pending.kit,
    recommendedUses: pending.recommendedUses,
    outcome: "great_success",
    successAttempt,
    stockBefore: before,
    stockAfter: after,
    resultState: pending.resultState,
  });
}

export function useSolveFlow({
  applyOutcome,
  collectInput,
  currentStateSnapshot,
  latestResultRef,
  pendingStatsEventRef,
  queueStatsEvent,
  renderResult,
  setCalculateBusy,
  setDetailView,
  setLoading,
  setResultView,
  solveBestAvailable,
}: SolveFlowOptions) {
  const solveAndRenderInput = useCallback(
    async (input: SolverInput, previousAction?: RecommendationAction | null) => {
      setLoading({ active: true, text: DEFAULT_LOADING_TEXT });
      setCalculateBusy(true);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      try {
        const result = await solveBestAvailable(input);
        renderResult(result, previousAction);
        const diagnosticEvent = makeSolverDiagnosticEvent(result);
        if (diagnosticEvent) queueStatsEvent(diagnosticEvent);
      } catch (error) {
        latestResultRef.current = null;
        setResultView({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        setDetailView({ type: "empty", message: "오류가 발생했습니다." });
      } finally {
        setLoading({ active: false, text: DEFAULT_LOADING_TEXT });
        setCalculateBusy(false);
      }
    },
    [
      latestResultRef,
      queueStatsEvent,
      renderResult,
      setCalculateBusy,
      setDetailView,
      setLoading,
      setResultView,
      solveBestAvailable,
    ],
  );

  const runCalculation = useCallback(async () => {
    const input = collectInput();
    const pendingEvent = pendingStatsEventFromInput({
      currentStateSnapshot,
      input,
      pendingStatsEventRef,
    });
    if (pendingEvent) queueStatsEvent(pendingEvent);
    await solveAndRenderInput(input);
  }, [
    collectInput,
    currentStateSnapshot,
    pendingStatsEventRef,
    queueStatsEvent,
    solveAndRenderInput,
  ]);

  const applyOutcomeAndMaybeCalculate = useCallback(
    async (outcome: "success" | "fail") => {
      const previousAction = recommendationFromResult(latestResultRef.current);
      const applied = applyOutcome(outcome);
      if (applied?.outcome !== "fail") return;
      await solveAndRenderInput(applied.nextInput, previousAction);
    },
    [applyOutcome, latestResultRef, solveAndRenderInput],
  );

  return { applyOutcomeAndMaybeCalculate, runCalculation };
}
