import { type Dispatch, type SetStateAction, useCallback, useRef } from "react";
import { message, useI18n } from "../i18n/locale";
import type { LocalizedMessage } from "../i18n/messages.ko";
import type { StatsSubmissionEvent } from "../lib/statsSubmissionQueue";
import type { SolverInput } from "../types";
import type { DetailView, LoadingView, RecommendationAction, ResultView } from "../ui-types";
import { makeSolverDiagnosticEvent, makeSolverRecoveryEvent } from "./calculatorDiagnostics";
import {
  DEFAULT_LOADING_TEXT,
  inputKey,
  makeStatsEvent,
  type PendingStatsEvent,
  type SolveOutcome,
  type SolverResult,
  sameState,
} from "./calculatorShared";
import type { ConvertApplyResult, OutcomeApplyResult } from "./outcomeFlowTypes";
import { SolverRecoveryFailure } from "./solverRecovery";
import { WorkerTaskCancelled } from "./solverWorkerClient";

type MutableRef<T> = { current: T };

type SolveFlowOptions = {
  applyConvert: () => ConvertApplyResult;
  applyOutcome: (outcome: "success" | "fail") => OutcomeApplyResult;
  collectInput: () => SolverInput;
  currentStateSnapshot: () => SolverInput["start"];
  latestResultRef: MutableRef<SolverResult | null>;
  pendingStatsEventRef: MutableRef<PendingStatsEvent | null>;
  prepareForSolve: () => void;
  queueStatsEvent: (event: StatsSubmissionEvent) => void;
  renderResult: (result: SolverResult, previousAction?: RecommendationAction | null) => void;
  setCalculateBusy: (busy: boolean) => void;
  setDetailView: Dispatch<SetStateAction<DetailView>>;
  setLoading: Dispatch<SetStateAction<LoadingView>>;
  setResultView: Dispatch<SetStateAction<ResultView>>;
  solveBestAvailable: (input: SolverInput) => Promise<SolveOutcome>;
};

type SolveAndRenderOptions = {
  beforeRender?: () => void;
  loadingText?: LocalizedMessage;
  previousAction?: RecommendationAction | null;
};

const OUTCOME_FAIL_LOADING_TEXT = message("result.loadingApplyFailure");
const OUTCOME_SUCCESS_LOADING_TEXT = message("result.loadingApplySuccess");
const MIN_LOADING_VISIBLE_MS = 300;

function calculationAfterOutcome(applied: NonNullable<OutcomeApplyResult>) {
  if (applied.outcome === "success" && !applied.autoCalculation) return null;
  const calculation = applied.outcome === "fail" ? applied : applied.autoCalculation;
  if (!calculation) return null;
  return {
    calculation,
    options: {
      ...(applied.outcome === "fail" ? { beforeRender: applied.commit } : {}),
      loadingText:
        applied.outcome === "fail" ? OUTCOME_FAIL_LOADING_TEXT : OUTCOME_SUCCESS_LOADING_TEXT,
      previousAction: calculation.previousAction,
    } satisfies SolveAndRenderOptions,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function preservesExistingResult(
  error: SolverRecoveryFailure,
  previousResult: SolverResult | null,
  input: SolverInput,
) {
  if (error.workerError.code !== "wasm_trap" || !previousResult?.input) return false;
  return inputKey(previousResult.input) === inputKey(input);
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
  const inferredAttempt = Math.round(usedKits / 10);
  const successAttempt = Math.min(
    pending.recommendedUses,
    Math.max(1, Number.isFinite(inferredAttempt) ? inferredAttempt : 1),
  );
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

type ManualCalculationOptions = Pick<
  SolveFlowOptions,
  "collectInput" | "currentStateSnapshot" | "pendingStatsEventRef" | "queueStatsEvent"
> & {
  isBusy: () => boolean;
  solveAndRenderInput: (input: SolverInput) => Promise<boolean>;
};

function useManualCalculation({
  collectInput,
  currentStateSnapshot,
  isBusy,
  pendingStatsEventRef,
  queueStatsEvent,
  solveAndRenderInput,
}: ManualCalculationOptions) {
  return useCallback(async () => {
    if (isBusy()) return;
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
    isBusy,
    pendingStatsEventRef,
    queueStatsEvent,
    solveAndRenderInput,
  ]);
}

export function useSolveFlow({
  applyConvert,
  applyOutcome,
  collectInput,
  currentStateSnapshot,
  latestResultRef,
  pendingStatsEventRef,
  prepareForSolve,
  queueStatsEvent,
  renderResult,
  setCalculateBusy,
  setDetailView,
  setLoading,
  setResultView,
  solveBestAvailable,
}: SolveFlowOptions) {
  const { locale } = useI18n();
  const busyRef = useRef(false);
  const isBusy = useCallback(() => busyRef.current, []);

  const solveAndRenderInput = useCallback(
    async (input: SolverInput, options: SolveAndRenderOptions = {}) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      const calculationLocale = locale;
      let skipUiCleanup = false;
      const loadingStartedAt = performance.now();
      try {
        prepareForSolve();
        setLoading({ active: true, text: options.loadingText ?? DEFAULT_LOADING_TEXT });
        setCalculateBusy(true);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const outcome = await solveBestAvailable(input);
        const result = outcome.result;
        options.beforeRender?.();
        renderResult(result, options.previousAction);
        const diagnosticEvent = makeSolverDiagnosticEvent(outcome, calculationLocale);
        if (diagnosticEvent) queueStatsEvent(diagnosticEvent);
        const recoveryEvent = makeSolverRecoveryEvent(result.input, outcome.recoveryTrace);
        if (recoveryEvent) queueStatsEvent(recoveryEvent);
        return true;
      } catch (error) {
        if (
          error instanceof WorkerTaskCancelled &&
          error.cancellation.task === "solve" &&
          error.cancellation.reason === "component_unmount"
        ) {
          skipUiCleanup = true;
          return false;
        }
        if (error instanceof SolverRecoveryFailure) {
          const recoveryEvent = makeSolverRecoveryEvent(input, error.trace);
          if (recoveryEvent) queueStatsEvent(recoveryEvent);
          if (preservesExistingResult(error, latestResultRef.current, input)) return false;
        }
        latestResultRef.current = null;
        setResultView({
          type: "error",
          reason: "solver_failure",
          message: message("result.solverError"),
        });
        setDetailView({ type: "empty", message: message("result.solverError") });
        return true;
      } finally {
        if (!skipUiCleanup) {
          const remainingMs = MIN_LOADING_VISIBLE_MS - (performance.now() - loadingStartedAt);
          if (remainingMs > 0) await delay(remainingMs);
          setLoading({ active: false, text: DEFAULT_LOADING_TEXT });
          setCalculateBusy(false);
        }
        busyRef.current = false;
      }
    },
    [
      latestResultRef,
      locale,
      prepareForSolve,
      queueStatsEvent,
      renderResult,
      setCalculateBusy,
      setDetailView,
      setLoading,
      setResultView,
      solveBestAvailable,
    ],
  );

  const runCalculation = useManualCalculation({
    collectInput,
    currentStateSnapshot,
    isBusy,
    pendingStatsEventRef,
    queueStatsEvent,
    solveAndRenderInput,
  });

  const applyOutcomeAndMaybeCalculate = useCallback(
    async (outcome: "success" | "fail") => {
      if (busyRef.current) return null;
      const applied = applyOutcome(outcome);
      if (!applied) return null;
      const next = calculationAfterOutcome(applied);
      if (!next) return applied;
      const started = await solveAndRenderInput(next.calculation.nextInput, next.options);
      return started ? applied : null;
    },
    [applyOutcome, solveAndRenderInput],
  );

  const applyConvertAndCalculate = useCallback(async () => {
    if (busyRef.current) return null;
    const applied = applyConvert();
    if (applied.needsStockEdit) return applied;
    const started = await solveAndRenderInput(applied.nextInput);
    return started ? applied : null;
  }, [applyConvert, solveAndRenderInput]);

  return { applyConvertAndCalculate, applyOutcomeAndMaybeCalculate, runCalculation };
}
