import { WorkerRequestSchema } from "./schemas";
import { solve } from "./solver/solve";

import type {
  ProgressEvent,
  SolverInput,
  WorkerErrorCode,
  WorkerErrorPayload,
  WorkerRequest,
  WorkerResponse,
} from "./types";
import { solveRustMinEf } from "./wasm/rustMinEfSolver";
import { solveRustPhase2 } from "./wasm/rustPhase2ProductSolver";
import { validateRustMinEf, validateRustPhase2 } from "./wasm/rustProductValidation";
import { RUST_STATUS_MEMO_FULL, RustSolveError } from "./wasm/rustStatus";

const WORKER_MESSAGE_ID_KEY = "id";

function postWorkerMessage(message: WorkerResponse) {
  self.postMessage(message);
}

let rustTaskQueue: Promise<void> = Promise.resolve();

function runRustTask<T>(task: () => Promise<T>): Promise<T> {
  const run = rustTaskQueue.then(task, task);
  rustTaskQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

self.onmessage = async (event) => {
  const parsed = WorkerRequestSchema.safeParse(event.data || {});
  if (!parsed.success) {
    postWorkerMessage({
      type: "error",
      id: messageId(event.data),
      code: "invalid_worker_payload",
      fallbackEligible: true,
      message: "Invalid worker request.",
      retryable: false,
    });
    return;
  }

  const data = parsed.data as WorkerRequest;

  try {
    if (data.backend === "rust-phase2" || data.backend === "rust-min-ef") {
      const wasmUrl = typeof data.wasmUrl === "string" ? data.wasmUrl : "";
      if (!wasmUrl) {
        throw workerTaskError({
          code: "wasm_url_missing",
          fallbackEligible: true,
          message: "Rust solver WASM URL is missing.",
          retryable: false,
        });
      }
      const solveRust: (
        input: SolverInput,
        wasmUrl: string,
        progress?: (progress: ProgressEvent) => void,
      ) => Promise<unknown> = data.backend === "rust-phase2" ? solveRustPhase2 : solveRustMinEf;
      const validateRust: (
        input: SolverInput,
        wasmUrl: string,
        runs: number,
        seed?: number,
      ) => Promise<unknown> =
        data.backend === "rust-phase2" ? validateRustPhase2 : validateRustMinEf;
      if (data.type === "validate") {
        const runs = Math.max(0, Math.floor(Number(data.runs) || 0));
        const seed = Math.max(0, Math.floor(Number(data.seed) || 20260505));
        const result = await runRustTask(() => validateRust(data.input, wasmUrl, runs, seed));
        postWorkerMessage({ type: "result", id: data.id, result });
        return;
      }
      const result = await runRustTask(() =>
        solveRust(data.input, wasmUrl, (progress: ProgressEvent) => {
          postWorkerMessage({ type: "progress", id: data.id, progress });
        }),
      );
      postWorkerMessage({ type: "result", id: data.id, result });
      return;
    }

    const input =
      data.type === "validate"
        ? {
            ...(data.input || {}),
            monteCarloRuns: Math.max(0, Math.floor(Number(data.runs) || 0)),
            monteCarloSeed: Math.max(0, Math.floor(Number(data.seed) || 20260505)),
          }
        : data.input;
    const result = solve(input, (progress: ProgressEvent) => {
      postWorkerMessage({ type: "progress", id: data.id, progress });
    });
    postWorkerMessage({
      type: "result",
      id: data.id,
      result: data.type === "validate" ? result.monteCarlo : result,
    });
  } catch (error) {
    const payload = workerErrorPayload(error);
    postWorkerMessage({
      type: "error",
      id: data.id,
      ...payload,
    });
  }
};

function messageId(value: unknown) {
  if (!value || typeof value !== "object") return 0;
  const id = (value as Record<string, unknown>)[WORKER_MESSAGE_ID_KEY];
  return typeof id === "number" && Number.isFinite(id) ? id : 0;
}

function workerTaskError(payload: WorkerErrorPayload) {
  const error = new Error(payload.message) as Error & { workerPayload?: WorkerErrorPayload };
  error.workerPayload = payload;
  return error;
}

function workerErrorPayload(error: unknown): WorkerErrorPayload {
  const workerPayload =
    error instanceof Error
      ? (error as Error & { workerPayload?: WorkerErrorPayload }).workerPayload
      : undefined;
  if (workerPayload) return workerPayload;

  if (error instanceof RustSolveError) {
    return {
      code: rustSolveErrorCode(error),
      fallbackEligible: error.reason !== "stale_handle",
      message: error.message,
      retryable: error.reason === "status",
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    code: inferWorkerErrorCode(message),
    fallbackEligible: true,
    message,
    retryable: true,
  };
}

function rustSolveErrorCode(error: RustSolveError): WorkerErrorCode {
  if (error.reason === "missing_export") return "missing_export";
  if (error.reason === "status" && error.status === RUST_STATUS_MEMO_FULL) return "memo_full";
  if (error.reason === "status") return "rust_status";
  return "worker_error";
}

function inferWorkerErrorCode(message: string): WorkerErrorCode {
  if (/wasm|webassembly|instantiate|fetch/i.test(message)) return "wasm_load_failed";
  return "worker_error";
}
