import type { WorkerErrorCode, WorkerSolverBackend } from "../../shared/workerProtocol";
import type { SolverInput } from "../types";

export const RECOVERY_POLICY_VERSION = "ladder_v1" as const;
export const SOLVE_DEADLINE_MS = 25_000;
export const RUST_RUNG_TIMEOUT_MS = 15_000;

export type SolverRecoveryExit = "not_attempted" | "success" | WorkerErrorCode;
export type SolverRecoveryTrace = {
  jsExit: SolverRecoveryExit;
  minEfExit: SolverRecoveryExit;
  phase2Exit: SolverRecoveryExit;
  policyVersion: typeof RECOVERY_POLICY_VERSION;
  requestedBackend: WorkerSolverBackend;
  terminalBackend: WorkerSolverBackend | "none";
  terminalOutcome: "failure" | "success";
};

type ErrorCategory =
  | "capacity"
  | "deployment"
  | "infrastructure"
  | "integrity"
  | "invariant"
  | "runtime";
type ErrorTraits = {
  category: ErrorCategory;
  jsSemanticallySafe: boolean;
};

export const WORKER_ERROR_TRAITS = {
  budget_exceeded: {
    category: "capacity",
    jsSemanticallySafe: true,
  },
  invalid_worker_payload: {
    category: "integrity",
    jsSemanticallySafe: false,
  },
  invalid_worker_response: {
    category: "integrity",
    jsSemanticallySafe: false,
  },
  memo_full: { category: "capacity", jsSemanticallySafe: true },
  missing_export: { category: "deployment", jsSemanticallySafe: true },
  rust_timeout: { category: "capacity", jsSemanticallySafe: true },
  solve_in_flight: {
    category: "invariant",
    jsSemanticallySafe: false,
  },
  stale_handle: { category: "integrity", jsSemanticallySafe: false },
  unknown_rust_status: {
    category: "integrity",
    jsSemanticallySafe: false,
  },
  wasm_load_failed: {
    category: "infrastructure",
    jsSemanticallySafe: true,
  },
  wasm_trap: {
    category: "runtime",
    jsSemanticallySafe: false,
  },
  wasm_url_missing: {
    category: "deployment",
    jsSemanticallySafe: true,
  },
  worker_error: {
    category: "infrastructure",
    jsSemanticallySafe: true,
  },
  worker_queue_timeout: {
    category: "capacity",
    jsSemanticallySafe: true,
  },
  worker_timeout: { category: "capacity", jsSemanticallySafe: true },
  worker_unavailable: {
    category: "infrastructure",
    jsSemanticallySafe: true,
  },
} satisfies Record<WorkerErrorCode, ErrorTraits>;

export type SolveRecoveryDecision =
  | { action: "fail"; reason: "deadline" | "integrity" | "no_safe_fallback" }
  | { action: "retry_phase2" }
  | { action: "run_js_main_thread" }
  | { action: "run_js_worker" };

function isIntegrityFailure(traits: ErrorTraits) {
  return traits.category === "integrity" || traits.category === "invariant";
}

export function decideSolveRecovery({
  attemptedBackend,
  errorCode,
  fallbackEligible,
  jsInputAllowed,
  remainingMs,
}: {
  attemptedBackend: WorkerSolverBackend;
  errorCode: WorkerErrorCode;
  fallbackEligible: boolean;
  jsInputAllowed: boolean;
  remainingMs: number;
}): SolveRecoveryDecision {
  if (remainingMs <= 0) return { action: "fail", reason: "deadline" };
  const traits = WORKER_ERROR_TRAITS[errorCode];
  if (isIntegrityFailure(traits)) {
    return { action: "fail", reason: "integrity" };
  }
  if (!fallbackEligible) return { action: "fail", reason: "no_safe_fallback" };
  if (attemptedBackend === "js-phase2") {
    return errorCode === "worker_unavailable" && jsInputAllowed
      ? { action: "run_js_main_thread" }
      : { action: "fail", reason: "no_safe_fallback" };
  }
  if (
    attemptedBackend === "rust-min-ef" &&
    (traits.category === "capacity" || errorCode === "worker_error")
  ) {
    return { action: "retry_phase2" };
  }
  if (attemptedBackend === "rust-phase2" && traits.category === "capacity") {
    return { action: "fail", reason: "no_safe_fallback" };
  }
  if (!traits.jsSemanticallySafe || !jsInputAllowed) {
    return { action: "fail", reason: "no_safe_fallback" };
  }
  return errorCode === "worker_unavailable"
    ? { action: "run_js_main_thread" }
    : { action: "run_js_worker" };
}

export function isLightweightJsInput(input: SolverInput) {
  if (input.start.grade === "SR" && input.start.level >= 15) return true;
  const totalUses =
    Math.floor(input.stock.blue / 10) +
    Math.floor(input.stock.purple / 10) +
    Math.floor(input.stock.yellow / 10);
  if (totalUses <= 12) return true;
  return input.start.grade === "SR" && input.start.level >= 8;
}

export function remainingDeadlineMs(deadlineAt: number, now = performance.now()) {
  return Math.max(0, deadlineAt - now);
}
