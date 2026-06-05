import { WorkerRequestSchema } from "./schemas";
import { solve } from "./solver";

import type { ProgressEvent, SolverInput, WorkerRequest, WorkerResponse } from "./types";
import {
  solveRustMinEf,
  solveRustPhase2,
  solveRustPhase2Rerank,
  validateRustMinEf,
  validateRustPhase2,
  validateRustPhase2Rerank,
} from "./wasm/rustMinEfSolver";

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
      message: "Invalid worker request.",
    });
    return;
  }

  const data = parsed.data as WorkerRequest;

  try {
    if (
      data.backend === "rust-phase2" ||
      data.backend === "rust-phase2-rerank" ||
      data.backend === "rust-min-ef"
    ) {
      const wasmUrl = typeof data.wasmUrl === "string" ? data.wasmUrl : "";
      if (!wasmUrl) throw new Error("Rust solver WASM URL is missing.");
      const solveRust: (
        input: SolverInput,
        wasmUrl: string,
        progress?: (progress: ProgressEvent) => void,
      ) => Promise<unknown> =
        data.backend === "rust-phase2"
          ? solveRustPhase2
          : data.backend === "rust-phase2-rerank"
            ? solveRustPhase2Rerank
            : solveRustMinEf;
      const validateRust: (
        input: SolverInput,
        wasmUrl: string,
        runs: number,
        seed?: number,
      ) => Promise<unknown> =
        data.backend === "rust-phase2"
          ? validateRustPhase2
          : data.backend === "rust-phase2-rerank"
            ? validateRustPhase2Rerank
            : validateRustMinEf;
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
    postWorkerMessage({
      type: "error",
      id: data.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

function messageId(value: unknown) {
  if (!value || typeof value !== "object") return 0;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "number" && Number.isFinite(id) ? id : 0;
}
