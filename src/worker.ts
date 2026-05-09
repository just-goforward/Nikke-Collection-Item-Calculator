import { solve } from "./solver";

import type { ProgressEvent, WorkerRequest, WorkerResponse } from "./types";

function postWorkerMessage(message: WorkerResponse) {
  self.postMessage(message);
}

self.onmessage = (event) => {
  const data = (event.data || {}) as WorkerRequest;
  if (data.type !== "solve" && data.type !== "validate") return;

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
      message: error && error.message ? error.message : String(error),
    });
  }
};
