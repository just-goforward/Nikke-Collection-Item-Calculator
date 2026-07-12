import type { WorkerSolverBackend } from "../../shared/workerProtocol";
import type { ProgressEvent, SolverInput } from "../types";
import { RUST_PHASE2_FALLBACK_MEMO_TIER } from "../wasm/rustProductConfig";
import type { SolverResult } from "./calculatorShared";
import { solveWithJsFallback } from "./solverFallback";
import {
  decideSolveRecovery,
  isLightweightJsInput,
  RECOVERY_POLICY_VERSION,
  RUST_RUNG_TIMEOUT_MS,
  remainingDeadlineMs,
  SOLVE_DEADLINE_MS,
  type SolverRecoveryExit,
  type SolverRecoveryTrace,
} from "./solverRecoveryPolicy";
import {
  classifyWorkerFailure,
  type WorkerClientTiming,
  WorkerTaskError,
  type WorkerTaskRequester,
} from "./solverWorkerClient";

type WorkerReset = () => WorkerTaskError | null;
type ValidationPreempt = () => WorkerTaskError | null;

export type RecoveredSolve = {
  initialError: WorkerTaskError | null;
  result: SolverResult;
  timing: WorkerClientTiming | null;
  trace: SolverRecoveryTrace;
};

export class SolverRecoveryFailure extends Error {
  readonly trace: SolverRecoveryTrace;
  readonly workerError: WorkerTaskError;

  constructor(workerError: WorkerTaskError, trace: SolverRecoveryTrace) {
    super(workerError.message, { cause: workerError });
    this.name = "SolverRecoveryFailure";
    this.trace = trace;
    this.workerError = workerError;
  }
}

type WorkerAttempt =
  | { error: WorkerTaskError; kind: "error" }
  | { kind: "success"; result: SolverResult; timing: WorkerClientTiming | null };

async function attemptWorkerSolve({
  backend,
  deadlineAt,
  input,
  onProgress,
  payload,
  requestWorkerTask,
}: {
  backend: WorkerSolverBackend;
  deadlineAt: number;
  input: SolverInput;
  onProgress: (progress: ProgressEvent) => void;
  payload?: Record<string, unknown>;
  requestWorkerTask: WorkerTaskRequester;
}): Promise<WorkerAttempt> {
  const remainingMs = remainingDeadlineMs(deadlineAt);
  if (remainingMs <= 0) {
    return {
      error: new WorkerTaskError({
        code: "worker_timeout",
        fallbackEligible: false,
        message: "Solver recovery deadline expired.",
        retryable: false,
      }),
      kind: "error",
    };
  }
  let timing: WorkerClientTiming | null = null;
  try {
    const result = (await requestWorkerTask("solve", input, {
      backend,
      executionTimeoutMs: Math.min(RUST_RUNG_TIMEOUT_MS, remainingMs),
      onProgress,
      onTiming: (value) => {
        timing = value;
      },
      ...(payload ? { payload } : {}),
      queueTimeoutMs: remainingMs,
    })) as SolverResult;
    return { kind: "success", result, timing };
  } catch (error) {
    const failure = classifyWorkerFailure(error);
    if (failure.kind !== "worker_error") throw failure.error;
    return { error: failure.error, kind: "error" };
  }
}

function resetForNextRung(
  preemptValidationForNextRung: ValidationPreempt,
  resetFailedWorker: WorkerReset,
) {
  const preemptionError = preemptValidationForNextRung();
  if (preemptionError) throw preemptionError;
  const resetError = resetFailedWorker();
  if (resetError) throw resetError;
}

function initialRecoveryTrace(requestedBackend: WorkerSolverBackend): SolverRecoveryTrace {
  return {
    jsExit: "not_attempted",
    minEfExit: "not_attempted",
    phase2Exit: "not_attempted",
    policyVersion: RECOVERY_POLICY_VERSION,
    requestedBackend,
    terminalBackend: "none",
    terminalOutcome: "failure",
  };
}

function setRungExit(
  trace: SolverRecoveryTrace,
  backend: WorkerSolverBackend,
  exit: SolverRecoveryExit,
) {
  if (backend === "rust-min-ef") trace.minEfExit = exit;
  else if (backend === "rust-phase2") trace.phase2Exit = exit;
  else trace.jsExit = exit;
}

function withRecoveryStats(
  result: SolverResult,
  attemptedBackend: WorkerSolverBackend,
  initialError: WorkerTaskError,
  startedAt: number,
): SolverResult {
  return {
    ...result,
    stats: {
      ...(result.stats || {}),
      ...(initialError.nodeCount === null ? {} : { attemptedStates: initialError.nodeCount }),
      fallbackFrom: attemptedBackend,
      fallbackReason: initialError.code,
      solveMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
      workerErrorCode: initialError.code,
    },
  };
}

export async function solveWithClientRecovery({
  input,
  onProgress,
  preemptValidationForNextRung,
  primaryBackend,
  requestWorkerTask,
  resetFailedWorker,
}: {
  input: SolverInput;
  onProgress: (progress: ProgressEvent) => void;
  preemptValidationForNextRung: ValidationPreempt;
  primaryBackend: WorkerSolverBackend;
  requestWorkerTask: WorkerTaskRequester;
  resetFailedWorker: WorkerReset;
}): Promise<RecoveredSolve> {
  const startedAt = performance.now();
  const deadlineAt = startedAt + SOLVE_DEADLINE_MS;
  const jsInputAllowed = isLightweightJsInput(input);
  const trace = initialRecoveryTrace(primaryBackend);
  let attemptedBackend = primaryBackend;
  let initialError: WorkerTaskError | null = null;
  let payload: Record<string, unknown> | undefined;

  while (true) {
    const attempt = await attemptWorkerSolve({
      backend: attemptedBackend,
      deadlineAt,
      input,
      onProgress,
      ...(payload ? { payload } : {}),
      requestWorkerTask,
    });
    if (attempt.kind === "success") {
      setRungExit(trace, attemptedBackend, "success");
      trace.terminalBackend = attemptedBackend;
      trace.terminalOutcome = "success";
      return {
        initialError,
        result: initialError
          ? withRecoveryStats(attempt.result, primaryBackend, initialError, startedAt)
          : attempt.result,
        timing: attempt.timing,
        trace: { ...trace },
      };
    }

    setRungExit(trace, attemptedBackend, attempt.error.code);
    initialError ??= attempt.error;
    const decision = decideSolveRecovery({
      attemptedBackend,
      errorCode: attempt.error.code,
      fallbackEligible: attempt.error.fallbackEligible,
      jsInputAllowed,
      remainingMs: remainingDeadlineMs(deadlineAt),
    });
    if (decision.action === "fail") {
      trace.terminalBackend = attemptedBackend;
      throw new SolverRecoveryFailure(attempt.error, { ...trace });
    }
    if (decision.action === "run_js_main_thread") {
      const result = await solveWithJsFallback(input, onProgress);
      trace.jsExit = "success";
      trace.terminalBackend = "js-phase2";
      trace.terminalOutcome = "success";
      return {
        initialError,
        result: withRecoveryStats(result, primaryBackend, initialError, startedAt),
        timing: null,
        trace: { ...trace },
      };
    }

    resetForNextRung(preemptValidationForNextRung, resetFailedWorker);
    if (decision.action === "retry_phase2") {
      attemptedBackend = "rust-phase2";
      payload = {
        phase2MemoTier: RUST_PHASE2_FALLBACK_MEMO_TIER,
        phase2RetryOnMemoFull: false,
      };
      continue;
    }
    attemptedBackend = "js-phase2";
    payload = undefined;
  }
}
