import { describe, expect, it, vi } from "vitest";

import {
  createTaskFinisher,
  solvePreemptionError,
  WorkerTaskCancelled,
  workerEventOutcome,
} from "./solverWorkerClient";

describe("workerEventOutcome", () => {
  it("classifies malformed responses as integrity failures", () => {
    const outcome = workerEventOutcome({ id: 1, type: "result", timing: { queueWaitMs: -1 } }, 1);

    expect(outcome.kind).toBe("invalid");
    if (outcome.kind !== "invalid") throw new Error("Expected invalid response.");
    expect(outcome.error).toMatchObject({
      code: "invalid_worker_response",
      fallbackEligible: false,
      retryable: false,
    });
  });

  it("ignores valid responses for another request", () => {
    expect(workerEventOutcome({ id: 2, type: "result", result: "other" }, 1)).toEqual({
      kind: "ignore",
    });
  });
});

describe("worker task lifecycle", () => {
  it("settles and cleans up exactly once across competing completions", () => {
    const cleanup = vi.fn();
    const reject = vi.fn();
    const resolve = vi.fn();
    const finish = createTaskFinisher({ cleanup, reject, resolve });
    const cancellation = new WorkerTaskCancelled({
      reason: "component_unmount",
      task: "solve",
    });

    finish({ kind: "resolve", result: "first" });
    finish({ failure: cancellation, kind: "reject" });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith("first");
    expect(reject).not.toHaveBeenCalled();
  });

  it("rejects solve preemption without mutating mixed task state", () => {
    expect(solvePreemptionError(["validate", "solve"])).toMatchObject({
      code: "solve_in_flight",
      fallbackEligible: false,
    });
    expect(solvePreemptionError(["validate", "validate"])).toBeNull();
  });
});
