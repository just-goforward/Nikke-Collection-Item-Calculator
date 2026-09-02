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
  LOADING_DETAIL,
  LOADING_RESULT,
  type PendingStatsEvent,
  type SolveOutcome,
  type SolverResult,
} from "./calculatorShared";
import { resolvePendingStockCorrection } from "./calculatorStockCorrection";
import type { ConvertApplyResult, OutcomeApplyResult } from "./outcomeFlowTypes";
import { SolverRecoveryFailure } from "./solverRecovery";
import { WorkerTaskCancelled } from "./solverWorkerClient";

type MutableRef<T> = { current: T };

type SolveFlowOptions = {
  applyConvert: () => ConvertApplyResult | null;
  applyOutcome: (outcome: "success" | "fail") => OutcomeApplyResult;
  collectInput: () => SolverInput;
  getCurrentViews: () => { detail: DetailView; result: ResultView };
  inputRevisionRef: MutableRef<number>;
  latestResultRef: MutableRef<SolverResult | null>;
  pendingStatsEventRef: MutableRef<PendingStatsEvent | null>;
  prepareForSolve: () => void;
  queueStatsEvent: (event: StatsSubmissionEvent) => void;
  renderResult: (result: SolverResult, previousAction?: RecommendationAction | null) => void;
  setCalculateBusy: (busy: boolean) => void;
  setDetailView: Dispatch<SetStateAction<DetailView>>;
  setLoading: Dispatch<SetStateAction<LoadingView>>;
  setManualStockEditRequired: (required: boolean) => void;
  setPendingStatsEvent: (event: PendingStatsEvent | null) => void;
  setResultView: Dispatch<SetStateAction<ResultView>>;
  solveBestAvailable: (input: SolverInput) => Promise<SolveOutcome>;
};

type SolveAndRenderOptions = {
  failureContext?: "outcome" | "conversion";
  loadingText?: LocalizedMessage;
  previousAction?: RecommendationAction | null;
};

const OUTCOME_FAIL_LOADING_TEXT = message("result.loadingApplyFailure");
const OUTCOME_SUCCESS_LOADING_TEXT = message("result.loadingApplySuccess");
const LOADING_SHOW_DELAY_MS = 120;
const MIN_LOADING_VISIBLE_MS = 180;

function calculationAfterOutcome(applied: NonNullable<OutcomeApplyResult>) {
  if (applied.outcome === "success" && applied.needsStockEdit) return null;
  if (applied.outcome === "success" && !applied.autoCalculation) return null;
  const calculation = applied.outcome === "fail" ? applied : applied.autoCalculation;
  if (!calculation) return null;
  return {
    calculation,
    options: {
      failureContext: "outcome",
      loadingText:
        applied.outcome === "fail" ? OUTCOME_FAIL_LOADING_TEXT : OUTCOME_SUCCESS_LOADING_TEXT,
      previousAction: calculation.previousAction,
    } satisfies SolveAndRenderOptions,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function startDeferredLoading(setLoading: SolveFlowOptions["setLoading"], text: LocalizedMessage) {
  let shownAt: number | null = null;
  setLoading({ active: false, text });
  const timer = window.setTimeout(() => {
    shownAt = performance.now();
    setLoading((current) => ({ ...current, active: true }));
  }, LOADING_SHOW_DELAY_MS);

  return {
    finish: async (skipUiCleanup: boolean) => {
      window.clearTimeout(timer);
      if (skipUiCleanup) return;
      if (shownAt !== null) {
        const remainingMs = MIN_LOADING_VISIBLE_MS - (performance.now() - shownAt);
        if (remainingMs > 0) await delay(remainingMs);
      }
    },
  };
}

function preservesExistingResult(
  error: SolverRecoveryFailure,
  previousResult: SolverResult | null,
  input: SolverInput,
) {
  if (error.workerError.code !== "wasm_trap" || !previousResult?.input) return false;
  return inputKey(previousResult.input) === inputKey(input);
}

type SolveFailureOptions = Pick<
  SolveFlowOptions,
  "inputRevisionRef" | "latestResultRef" | "queueStatsEvent"
> & {
  error: unknown;
  input: SolverInput;
  inputRevision: number;
  failureContext?: SolveAndRenderOptions["failureContext"];
};

type SolveFailureResolution = {
  result: boolean;
  restorePreviousViews: boolean;
  skipUiCleanup: boolean;
  views?: { detail: DetailView; result: ResultView };
};

function isPrecisionCapacityFailure(error: unknown) {
  return (
    error instanceof SolverRecoveryFailure &&
    error.trace.terminalBackend === "rust-phase2" &&
    (error.workerError.code === "memo_full" ||
      error.workerError.code === "memory_limit" ||
      error.workerError.code === "rust_timeout")
  );
}

export function solveFailurePresentation(
  error: unknown,
  failureContext?: SolveAndRenderOptions["failureContext"],
) {
  const capacityFailure = isPrecisionCapacityFailure(error);
  if (failureContext === "outcome") {
    return {
      reason: "follow_up_outcome_failure" as const,
      message: capacityFailure
        ? message("result.followUpOutcomeCapacityError")
        : message("result.followUpOutcomeError"),
    };
  }
  if (failureContext === "conversion") {
    return {
      reason: "follow_up_conversion_failure" as const,
      message: capacityFailure
        ? message("result.followUpConversionCapacityError")
        : message("result.followUpConversionError"),
    };
  }
  return capacityFailure
    ? {
        reason: "solver_capacity_failure" as const,
        message: message("result.solverCapacityError"),
      }
    : { reason: "solver_failure" as const, message: message("result.solverError") };
}

function handleSolveFailure({
  error,
  failureContext,
  input,
  inputRevision,
  inputRevisionRef,
  latestResultRef,
  queueStatsEvent,
}: SolveFailureOptions): SolveFailureResolution {
  if (inputRevisionRef.current !== inputRevision) {
    return { result: false, restorePreviousViews: true, skipUiCleanup: false };
  }
  if (
    error instanceof WorkerTaskCancelled &&
    error.cancellation.task === "solve" &&
    error.cancellation.reason === "component_unmount"
  ) {
    return { result: false, restorePreviousViews: false, skipUiCleanup: true };
  }
  if (error instanceof SolverRecoveryFailure) {
    const recoveryEvent = makeSolverRecoveryEvent(input, error.trace);
    if (recoveryEvent) queueStatsEvent(recoveryEvent);
    if (preservesExistingResult(error, latestResultRef.current, input)) {
      return { result: false, restorePreviousViews: true, skipUiCleanup: false };
    }
  }
  latestResultRef.current = null;
  const presentation = solveFailurePresentation(error, failureContext);
  return {
    result: true,
    restorePreviousViews: false,
    skipUiCleanup: false,
    views: {
      result: {
        type: "error" as const,
        reason: presentation.reason,
        message: presentation.message,
      },
      detail: { type: "empty" as const, message: presentation.message },
    },
  };
}

type ExecuteSolveOptions = Pick<
  SolveFlowOptions,
  | "getCurrentViews"
  | "inputRevisionRef"
  | "latestResultRef"
  | "prepareForSolve"
  | "queueStatsEvent"
  | "renderResult"
  | "setCalculateBusy"
  | "setDetailView"
  | "setLoading"
  | "setResultView"
  | "solveBestAvailable"
> & {
  busyRef: MutableRef<boolean>;
  calculationLocale: ReturnType<typeof useI18n>["locale"];
};

async function executeSolveAndRender(
  context: ExecuteSolveOptions,
  input: SolverInput,
  options: SolveAndRenderOptions,
) {
  if (context.busyRef.current) return false;
  context.busyRef.current = true;
  const inputRevision = context.inputRevisionRef.current;
  const loadingSession = startDeferredLoading(
    context.setLoading,
    options.loadingText ?? DEFAULT_LOADING_TEXT,
  );
  const previousViews = context.getCurrentViews();
  context.setCalculateBusy(true);
  context.setResultView(LOADING_RESULT);
  if (previousViews.detail.type !== "metrics") context.setDetailView(LOADING_DETAIL);
  let completedResult: SolverResult | null = null;
  let failureViews: { detail: DetailView; result: ResultView } | null = null;
  let restorePreviousViews = false;
  let skipUiCleanup = false;
  try {
    context.prepareForSolve();
    const outcome = await context.solveBestAvailable(input);
    if (context.inputRevisionRef.current !== inputRevision) {
      restorePreviousViews = true;
      return false;
    }
    const result = outcome.result;
    completedResult = result;
    const diagnosticEvent = makeSolverDiagnosticEvent(outcome, context.calculationLocale);
    if (diagnosticEvent) context.queueStatsEvent(diagnosticEvent);
    const recoveryEvent = makeSolverRecoveryEvent(result.input, outcome.recoveryTrace);
    if (recoveryEvent) context.queueStatsEvent(recoveryEvent);
    return true;
  } catch (error) {
    const failure = handleSolveFailure({
      ...context,
      error,
      failureContext: options.failureContext,
      input,
      inputRevision,
    });
    failureViews = failure.views ?? null;
    restorePreviousViews = failure.restorePreviousViews;
    skipUiCleanup = failure.skipUiCleanup;
    return failure.result;
  } finally {
    await loadingSession.finish(skipUiCleanup);
    if (!skipUiCleanup) {
      if (completedResult) {
        context.renderResult(completedResult, options.previousAction);
      } else if (failureViews) {
        context.setResultView(failureViews.result);
        context.setDetailView(failureViews.detail);
      } else if (restorePreviousViews) {
        context.setResultView(previousViews.result);
        context.setDetailView(previousViews.detail);
      }
      context.setCalculateBusy(false);
      context.setLoading({ active: false, text: DEFAULT_LOADING_TEXT });
    }
    context.busyRef.current = false;
  }
}

export function consumePendingStockCorrection({
  input,
  pendingStatsEventRef,
  queueStatsEvent,
  setManualStockEditRequired,
  setPendingStatsEvent,
}: {
  input: SolverInput;
  pendingStatsEventRef: MutableRef<PendingStatsEvent | null>;
  queueStatsEvent: (event: StatsSubmissionEvent) => void;
  setManualStockEditRequired: (required: boolean) => void;
  setPendingStatsEvent: (event: PendingStatsEvent | null) => void;
}) {
  const resolution = resolvePendingStockCorrection(
    pendingStatsEventRef.current,
    input.start,
    input.stock,
  );
  if (resolution.status === "none") return true;
  if (resolution.status === "invalid" && !resolution.canCalculate) return false;
  if (resolution.status === "valid") queueStatsEvent(resolution.event);
  setPendingStatsEvent(null);
  setManualStockEditRequired(false);
  return true;
}

type ManualCalculationOptions = Pick<
  SolveFlowOptions,
  | "collectInput"
  | "pendingStatsEventRef"
  | "queueStatsEvent"
  | "setManualStockEditRequired"
  | "setPendingStatsEvent"
> & {
  isBusy: () => boolean;
  solveAndRenderInput: (input: SolverInput) => Promise<boolean>;
};

function useManualCalculation({
  collectInput,
  isBusy,
  pendingStatsEventRef,
  queueStatsEvent,
  setManualStockEditRequired,
  setPendingStatsEvent,
  solveAndRenderInput,
}: ManualCalculationOptions) {
  return useCallback(async () => {
    if (isBusy()) return false;
    const input = collectInput();
    const correctionReady = consumePendingStockCorrection({
      input,
      pendingStatsEventRef,
      queueStatsEvent,
      setManualStockEditRequired,
      setPendingStatsEvent,
    });
    if (!correctionReady) return false;
    return solveAndRenderInput(input);
  }, [
    collectInput,
    isBusy,
    pendingStatsEventRef,
    queueStatsEvent,
    setManualStockEditRequired,
    setPendingStatsEvent,
    solveAndRenderInput,
  ]);
}

export function useSolveFlow({
  applyConvert,
  applyOutcome,
  collectInput,
  getCurrentViews,
  inputRevisionRef,
  latestResultRef,
  pendingStatsEventRef,
  prepareForSolve,
  queueStatsEvent,
  renderResult,
  setCalculateBusy,
  setDetailView,
  setLoading,
  setManualStockEditRequired,
  setPendingStatsEvent,
  setResultView,
  solveBestAvailable,
}: SolveFlowOptions) {
  const { locale } = useI18n();
  const busyRef = useRef(false);
  const isBusy = useCallback(() => busyRef.current, []);

  const solveAndRenderInput = useCallback(
    (input: SolverInput, options: SolveAndRenderOptions = {}) =>
      executeSolveAndRender(
        {
          busyRef,
          calculationLocale: locale,
          getCurrentViews,
          inputRevisionRef,
          latestResultRef,
          prepareForSolve,
          queueStatsEvent,
          renderResult,
          setCalculateBusy,
          setDetailView,
          setLoading,
          setResultView,
          solveBestAvailable,
        },
        input,
        options,
      ),
    [
      getCurrentViews,
      latestResultRef,
      inputRevisionRef,
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
    isBusy,
    pendingStatsEventRef,
    queueStatsEvent,
    setManualStockEditRequired,
    setPendingStatsEvent,
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
    if (!applied) return null;
    if (applied.needsStockEdit) return applied;
    const started = await solveAndRenderInput(applied.nextInput, {
      failureContext: "conversion",
    });
    return started ? applied : null;
  }, [applyConvert, solveAndRenderInput]);

  return { applyConvertAndCalculate, applyOutcomeAndMaybeCalculate, runCalculation };
}
