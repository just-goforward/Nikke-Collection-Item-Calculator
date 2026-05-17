import { WorkerRequestSchema } from "./schemas";
import { solve } from "./solver";

import type { ProgressEvent, WorkerRequest, WorkerResponse } from "./types";

function postWorkerMessage(message: WorkerResponse) {
  self.postMessage(message);
}

self.onmessage = (event) => {
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
