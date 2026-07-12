import type { SolverInput } from "./game";

export type WorkerTaskType = "solve" | "validate";
export type WorkerSolverBackend = "js-phase2" | "rust-phase2" | "rust-min-ef";

export type ProgressEvent = {
  phase: string;
  queueWaitMs?: number;
  scanned?: number;
  total?: number | null;
};

export type WorkerTaskTiming = {
  queueWaitMs: number;
  executionMs: number;
};

export const WORKER_ERROR_CODES = [
  "worker_unavailable",
  "rust_timeout",
  "worker_timeout",
  "worker_queue_timeout",
  "wasm_url_missing",
  "wasm_load_failed",
  "missing_export",
  "budget_exceeded",
  "memo_full",
  "stale_handle",
  "invalid_worker_payload",
  "invalid_worker_response",
  "unknown_rust_status",
  "solve_in_flight",
  "worker_error",
] as const;
export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number];

export type WorkerErrorPayload = {
  code: WorkerErrorCode;
  message: string;
  nodeCount?: number;
  retryable?: boolean;
  fallbackEligible?: boolean;
};

export type WorkerRequest =
  | {
      type: "solve";
      id: number;
      input: SolverInput;
      backend: WorkerSolverBackend;
      wasmUrl?: string;
      phase2MemoTier?: number;
      phase2RetryOnMemoFull?: boolean;
    }
  | {
      type: "validate";
      id: number;
      input: SolverInput;
      runs?: number;
      seed?: number;
      backend: WorkerSolverBackend;
      wasmUrl?: string;
    };

export type WorkerResponse =
  | { type: "progress"; id: number; progress: ProgressEvent }
  | { type: "result"; id: number; result: unknown; timing?: WorkerTaskTiming }
  | ({ type: "error"; id: number } & WorkerErrorPayload);

const BACKENDS = new Set<WorkerSolverBackend>(["js-phase2", "rust-phase2", "rust-min-ef"]);
const ERROR_CODES = new Set<WorkerErrorCode>(WORKER_ERROR_CODES);

type ParseResult<T> = { success: true; data: T } | { success: false };

type ProtocolRecord = Record<string, unknown> & {
  backend?: unknown;
  blue?: unknown;
  code?: unknown;
  exp?: unknown;
  fallbackEligible?: unknown;
  grade?: unknown;
  id?: unknown;
  input?: unknown;
  level?: unknown;
  message?: unknown;
  monteCarloRuns?: unknown;
  monteCarloSeed?: unknown;
  nodeCount?: unknown;
  phase?: unknown;
  phase2MemoTier?: unknown;
  phase2RetryOnMemoFull?: unknown;
  progress?: unknown;
  queueWaitMs?: unknown;
  purple?: unknown;
  result?: unknown;
  retryable?: unknown;
  runs?: unknown;
  scanned?: unknown;
  seed?: unknown;
  start?: unknown;
  stock?: unknown;
  strategy?: unknown;
  total?: unknown;
  timing?: unknown;
  executionMs?: unknown;
  type?: unknown;
  wasmUrl?: unknown;
  yellow?: unknown;
};

function isRecord(value: unknown): value is ProtocolRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown) {
  return value === undefined || isFiniteNumber(value);
}

function isSolverInput(value: unknown): value is SolverInput {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.stock)) return false;
  const { start, stock } = value;
  if (start.grade !== "R" && start.grade !== "SR") return false;
  if (!isFiniteNumber(start.level) || !isFiniteNumber(start.exp)) return false;
  if (
    !isFiniteNumber(stock.blue) ||
    !isFiniteNumber(stock.purple) ||
    !isFiniteNumber(stock.yellow)
  )
    return false;
  if (value.strategy !== undefined && value.strategy !== "single" && value.strategy !== "supply")
    return false;
  return (
    isOptionalFiniteNumber(value.monteCarloRuns) && isOptionalFiniteNumber(value.monteCarloSeed)
  );
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown) {
  return value === undefined || typeof value === "boolean";
}

function parseProgress(value: unknown): ProgressEvent | null {
  if (!isRecord(value) || typeof value.phase !== "string") return null;
  if (!isOptionalFiniteNumber(value.queueWaitMs)) return null;
  if (!isOptionalFiniteNumber(value.scanned)) return null;
  if (value.total !== undefined && value.total !== null && !isFiniteNumber(value.total)) return null;
  return {
    phase: value.phase,
    ...(value.queueWaitMs === undefined ? {} : { queueWaitMs: value.queueWaitMs }),
    ...(value.scanned === undefined ? {} : { scanned: value.scanned }),
    ...(value.total === undefined ? {} : { total: value.total }),
  };
}

function parseTiming(value: unknown): WorkerTaskTiming | null {
  if (!isRecord(value)) return null;
  if (!isFiniteNumber(value.queueWaitMs) || value.queueWaitMs < 0) return null;
  if (!isFiniteNumber(value.executionMs) || value.executionMs < 0) return null;
  return { queueWaitMs: value.queueWaitMs, executionMs: value.executionMs };
}

export function workerMessageId(value: unknown) {
  if (!isRecord(value) || !isFiniteNumber(value.id)) return 0;
  return value.id;
}

export function parseWorkerRequest(value: unknown): ParseResult<WorkerRequest> {
  if (!isRecord(value) || !isFiniteNumber(value.id) || !isSolverInput(value.input))
    return { success: false };
  if (typeof value.backend !== "string" || !BACKENDS.has(value.backend as WorkerSolverBackend))
    return { success: false };
  if (!optionalString(value.wasmUrl)) return { success: false };

  const base: Omit<WorkerRequest, "type" | "runs" | "seed" | "phase2MemoTier" | "phase2RetryOnMemoFull"> = {
    id: value.id,
    input: value.input,
    backend: value.backend as WorkerSolverBackend,
    ...(value.wasmUrl === undefined ? {} : { wasmUrl: value.wasmUrl }),
  };
  if (value.type === "solve") return parseSolveRequest(value, base);
  if (value.type === "validate") return parseValidationRequest(value, base);
  return { success: false };
}

function parseSolveRequest(
  value: ProtocolRecord,
  base: Omit<WorkerRequest, "type" | "runs" | "seed" | "phase2MemoTier" | "phase2RetryOnMemoFull">,
): ParseResult<WorkerRequest> {
  const phase2MemoTier = value.phase2MemoTier;
  if (
    phase2MemoTier !== undefined &&
    (!isFiniteNumber(phase2MemoTier) ||
      !Number.isInteger(phase2MemoTier) ||
      phase2MemoTier < 18 ||
      phase2MemoTier > 24)
  ) {
    return { success: false };
  }
  if (!optionalBoolean(value.phase2RetryOnMemoFull)) return { success: false };
  return {
    success: true,
    data: {
      type: "solve",
      ...base,
      ...(phase2MemoTier === undefined ? {} : { phase2MemoTier }),
      ...(value.phase2RetryOnMemoFull === undefined
        ? {}
        : { phase2RetryOnMemoFull: value.phase2RetryOnMemoFull }),
    },
  };
}

function parseValidationRequest(
  value: ProtocolRecord,
  base: Omit<WorkerRequest, "type" | "runs" | "seed" | "phase2MemoTier" | "phase2RetryOnMemoFull">,
): ParseResult<WorkerRequest> {
  if (!isOptionalFiniteNumber(value.runs) || !isOptionalFiniteNumber(value.seed))
    return { success: false };
  return {
    success: true,
    data: {
      type: "validate",
      ...base,
      ...(value.runs === undefined ? {} : { runs: value.runs }),
      ...(value.seed === undefined ? {} : { seed: value.seed }),
    },
  };
}

function parseResultResponse(value: ProtocolRecord & { id: number }): ParseResult<WorkerResponse> {
  const timing = value.timing === undefined ? undefined : parseTiming(value.timing);
  if (value.timing !== undefined && !timing) return { success: false };
  return {
    success: true,
    data: {
      type: "result",
      id: value.id,
      result: value.result,
      ...(timing ? { timing } : {}),
    },
  };
}

function parseProgressResponse(value: ProtocolRecord & { id: number }): ParseResult<WorkerResponse> {
  const progress = parseProgress(value.progress);
  return progress
    ? { success: true, data: { type: "progress", id: value.id, progress } }
    : { success: false };
}

function parseErrorResponse(value: ProtocolRecord & { id: number }): ParseResult<WorkerResponse> {
  if (
    typeof value.code !== "string" ||
    !ERROR_CODES.has(value.code as WorkerErrorCode) ||
    typeof value.message !== "string" ||
    !value.message ||
    !optionalBoolean(value.retryable) ||
    !optionalBoolean(value.fallbackEligible) ||
    (value.nodeCount !== undefined &&
      (!isFiniteNumber(value.nodeCount) || value.nodeCount < 0))
  )
    return { success: false };
  return {
    success: true,
    data: {
      type: "error",
      id: value.id,
      code: value.code as WorkerErrorCode,
      message: value.message,
      ...(value.nodeCount === undefined ? {} : { nodeCount: value.nodeCount }),
      ...(value.retryable === undefined ? {} : { retryable: value.retryable }),
      ...(value.fallbackEligible === undefined
        ? {}
        : { fallbackEligible: value.fallbackEligible }),
    },
  };
}

export function parseWorkerResponse(value: unknown): ParseResult<WorkerResponse> {
  if (!isRecord(value) || !isFiniteNumber(value.id)) return { success: false };
  const response = value as ProtocolRecord & { id: number };
  if (response.type === "result") return parseResultResponse(response);
  if (response.type === "progress") return parseProgressResponse(response);
  if (response.type === "error") return parseErrorResponse(response);
  return { success: false };
}
