import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from "react";
import { message, useI18n } from "../i18n/locale";
import type { LocalizedMessage } from "../i18n/messages.ko";
import { ignoreExpectedError } from "../lib/errorHandling";
import type { StatsSubmissionEvent } from "../lib/statsSubmissionQueue";
import { SUPPLY_UNAVAILABLE_MESSAGE } from "../lib/supplyForecastRuntime";
import type { SolverInput } from "../types";
import type { DetailView, LoadingView, RecommendationAction, ResultView } from "../ui-types";
import { makeSolverDiagnosticEvent, makeSolverRecoveryEvent } from "./calculatorDiagnostics";
import {
  DEFAULT_LOADING_TEXT,
  EMPTY_DETAIL,
  EMPTY_RESULT,
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
import { SERVICE_CERTIFIED_SOLVER } from "../lib/serviceCertified";
import { withoutRecommendedWait } from "./serviceCertifiedPresentation";
import { ServiceCertifiedCancelled, type ServiceCertifiedSolveOutcome } from "./serviceCertifiedTypes";
import { observeDecision, type DecisionLifecycle } from "../analytics/decisionLifecycle";
import { isOutcomeReportPending, retainPendingOutcomeSettlement, withAcceptedOutcomeCapture } from "../analytics/acceptedOutcome";

type MutableRef<T> = { current: T };

type SolveFlowOptions = {
  lifecycle?: DecisionLifecycle;
  observerOwner?: unknown;
  checkForecastBoundary?: () => boolean;
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
  solveBestAvailable: (
    input: SolverInput,
    onCurrent?: (result: SolverResult) => void,
  ) => Promise<SolveOutcome | ServiceCertifiedSolveOutcome>;
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
  if (!failureContext && error instanceof Error && error.message === SUPPLY_UNAVAILABLE_MESSAGE) {
    return { reason: "solver_failure" as const, message: message("staging.supplyUnavailable") };
  }
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

export function handleSolveFailure({
  error,
  failureContext,
  input,
  inputRevision,
  inputRevisionRef,
  latestResultRef,
  queueStatsEvent,
}: SolveFailureOptions): SolveFailureResolution {
  if (error instanceof ServiceCertifiedCancelled) {
    const keepNewerViews = inputRevisionRef.current !== inputRevision;
    if (!error.unmounted && !keepNewerViews) latestResultRef.current = null;
    return {
      result: false,
      restorePreviousViews: false,
      skipUiCleanup: error.unmounted,
      ...(!error.unmounted && !keepNewerViews
        ? { views: { result: EMPTY_RESULT, detail: EMPTY_DETAIL } } : {}),
    };
  }
  if (inputRevisionRef.current !== inputRevision) {
    return { result: false, restorePreviousViews: !SERVICE_CERTIFIED_SOLVER, skipUiCleanup: false };
  }
  if (
    error instanceof WorkerTaskCancelled &&
    error.cancellation.task === "solve" &&
    error.cancellation.reason === "component_unmount"
  ) {
    return { result: false, restorePreviousViews: false, skipUiCleanup: true };
  }
  if (error instanceof SolverRecoveryFailure) {
    const recoveryEvent = makeSolverRecoveryEvent(input, error.trace, error.supplyForecast);
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
      detail: {
        type: "empty" as const,
        message: presentation.message,
        waitingLabel: message("detail.wait.error"),
      },
    },
  };
}

type ExecuteSolveOptions = Pick<
  SolveFlowOptions,
  | "lifecycle"
  | "checkForecastBoundary"
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
  unmountedRef: MutableRef<boolean>;
  executionRef: MutableRef<number>;
  calculationLocale: ReturnType<typeof useI18n>["locale"];
};

export async function executeSolveAndRender(
  context: ExecuteSolveOptions,
  input: SolverInput,
  options: SolveAndRenderOptions,
) {
  if (context.busyRef.current || context.unmountedRef.current) return false;
  context.checkForecastBoundary?.();
  context.busyRef.current = true;
  const execution = ++context.executionRef.current;
  const observerOwner = observeDecision(context.lifecycle ? () => context.lifecycle!.begin(input) : undefined);
  const owns = () => execution === context.executionRef.current && !context.unmountedRef.current;
  const inputRevision = context.inputRevisionRef.current;
  const loadingSession = startDeferredLoading(
    context.setLoading,
    options.loadingText ?? DEFAULT_LOADING_TEXT,
  );
  const previous = context.getCurrentViews();
  const previousViews = { ...previous, detail: withoutRecommendedWait(previous.detail) };
  context.setCalculateBusy(true);
  context.setResultView(LOADING_RESULT);
  context.setDetailView(previousViews.detail.type === "metrics" ? previousViews.detail : LOADING_DETAIL);
  let completedResult: SolverResult | null = null;
  let failureViews: { detail: DetailView; result: ResultView } | null = null;
  let restorePreviousViews = false;
  let skipUiCleanup = false;
  let intendedResult = true;
  try {
    context.prepareForSolve();
    const outcome = await context.solveBestAvailable(input, (checkpoint) => {
      if (owns() && context.inputRevisionRef.current === inputRevision)
        context.renderResult(checkpoint, options.previousAction);
    });
    if (!owns() || context.inputRevisionRef.current !== inputRevision) {
      restorePreviousViews = !SERVICE_CERTIFIED_SOLVER;
      intendedResult = false;
    } else {
      const result = outcome.result;
      completedResult = result;
      if (!("kind" in outcome)) queueOutcomeDiagnostics(context, outcome);
    }
  } catch (error) {
    if (!owns()) {
      intendedResult = false;
      skipUiCleanup = true;
    } else {
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
      intendedResult = failure.result;
    }
  } finally {
    await loadingSession.finish(skipUiCleanup || !owns());
    if (execution === context.executionRef.current) context.busyRef.current = false;
    if (!skipUiCleanup && owns()) {
      const forecastCurrent = context.checkForecastBoundary?.() !== false;
      if (SERVICE_CERTIFIED_SOLVER && context.inputRevisionRef.current !== inputRevision) {
        // A reset/account switch during the minimum loading delay owns the new views.
      } else if (completedResult) {
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
      if (forecastCurrent && owns() && context.inputRevisionRef.current === inputRevision &&
          completedResult && observerOwner !== undefined) {
        const retainedResult = completedResult;
        const origin = retainedResult.certified?.final === false ? "current_checkpoint" : "final";
        observeDecision(context.lifecycle ?
          () => context.lifecycle!.accepted(observerOwner, input, retainedResult, origin) : undefined);
      }
    }
  }
  // A supersession during the deferred loading cleanup must not report success
  // to calculateAndClearStale, which would otherwise clear the new stale marker.
  return intendedResult && owns() &&
    (!SERVICE_CERTIFIED_SOLVER || context.inputRevisionRef.current === inputRevision);
}

export function queueOutcomeDiagnostics(
  context: Pick<ExecuteSolveOptions, "calculationLocale" | "queueStatsEvent">,
  outcome: SolveOutcome,
) {
  try {
    const diagnostic = makeSolverDiagnosticEvent(outcome, context.calculationLocale);
    if (diagnostic) context.queueStatsEvent(diagnostic);
    const recovery = makeSolverRecoveryEvent(
      outcome.result.input,
      outcome.recoveryTrace,
      outcome.result.stats?.supplyForecast ?? outcome.supplyForecast,
    );
    if (recovery) context.queueStatsEvent(recovery);
    return true;
  } catch (error) {
    // Telemetry delivery cannot revoke an already completed solve.
    ignoreExpectedError("Optional diagnostics could not be emitted; calculation retained", error);
    return false;
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
  if (resolution.status === "valid") {
    if (isOutcomeReportPending(pendingStatsEventRef.current!))
      retainPendingOutcomeSettlement(pendingStatsEventRef.current!, resolution.event);
    else queueStatsEvent(resolution.event);
  }
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
  lifecycle,
  observerOwner,
  checkForecastBoundary,
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
  const unmountedRef = useRef(false);
  const executionRef = useRef(0);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      ++executionRef.current;
      busyRef.current = false;
    };
  }, []);
  const captureCalculationOwnership = useCallback(() => {
    const execution = executionRef.current;
    const revision = inputRevisionRef.current;
    return () => !unmountedRef.current && executionRef.current === execution &&
      (!SERVICE_CERTIFIED_SOLVER || inputRevisionRef.current === revision);
  }, [inputRevisionRef]);
  const isBusy = useCallback(() => busyRef.current, []);
  // Product action eligibility belongs to the rendered core execution, even
  // when analytics is disabled or its parent event could not be queued.
  const ownsRenderedAction = captureCalculationOwnership();

  const solveAndRenderInput = useCallback(
    (input: SolverInput, options: SolveAndRenderOptions = {}) =>
      executeSolveAndRender(
        {
          ...(lifecycle ? { lifecycle } : {}),
          ...(checkForecastBoundary ? { checkForecastBoundary } : {}),
          busyRef,
          unmountedRef,
          executionRef,
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
      lifecycle,
      checkForecastBoundary,
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
      if (busyRef.current || !ownsRenderedAction()) return null;
      let prepared: unknown;
      let legacySettlement: StatsSubmissionEvent | undefined;
      const capture = observerOwner !== undefined && lifecycle?.prepareOutcome
        ? (context: Parameters<NonNullable<DecisionLifecycle["prepareOutcome"]>>[1]) => {
            prepared = observeDecision(() => lifecycle.prepareOutcome!(observerOwner, context));
            return prepared !== undefined;
          }
        : undefined;
      let applied: OutcomeApplyResult;
      try {
        applied = withAcceptedOutcomeCapture(capture, () => applyOutcome(outcome), event => {
          legacySettlement = event;
          observeDecision(() => lifecycle?.retainLegacySettlement?.(observerOwner, event));
        });
        if (!applied) return null;
        if (observerOwner !== undefined)
          observeDecision(lifecycle ? () => lifecycle.outcomeConfirmed(observerOwner, outcome, prepared, legacySettlement) : undefined);
      } finally {
        observeDecision(() => lifecycle?.releaseOutcomePreparation?.(prepared));
      }
      const next = calculationAfterOutcome(applied);
      if (!next) return applied;
      const started = await solveAndRenderInput(next.calculation.nextInput, next.options);
      return started ? applied : null;
    },
    [applyOutcome, solveAndRenderInput, lifecycle, observerOwner, ownsRenderedAction],
  );

  const applyConvertAndCalculate = useCallback(async () => {
    if (busyRef.current || !ownsRenderedAction()) return null;
    const applied = applyConvert();
    if (!applied) return null;
    if (applied.needsStockEdit) return applied;
    const started = await solveAndRenderInput(applied.nextInput, {
      failureContext: "conversion",
    });
    return started ? applied : null;
  }, [applyConvert, solveAndRenderInput, ownsRenderedAction]);

  return { applyConvertAndCalculate, applyOutcomeAndMaybeCalculate, runCalculation, captureCalculationOwnership };
}
