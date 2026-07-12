import { describe, expect, it, vi } from "vitest";

import { solveWithClientRecovery } from "./solverRecovery";
import { WorkerTaskError, type WorkerTaskRequester } from "./solverWorkerClient";

const INPUT = {
  start: { grade: "R", level: 0, exp: 0 },
  stock: { blue: 300, purple: 150, yellow: 150 },
  strategy: "supply",
} as const;

describe("solveWithClientRecovery", () => {
  it("moves min-E[f] capacity failure to a fresh tier-22 phase2 rung", async () => {
    const calls: Array<{
      backend: string | undefined;
      payload: Record<string, unknown> | undefined;
    }> = [];
    const requestWorkerTask: WorkerTaskRequester = vi.fn(async (_type, _input, options) => {
      calls.push({ backend: options?.backend, payload: options?.payload });
      if (options?.backend === "rust-min-ef") {
        throw new WorkerTaskError({
          code: "memo_full",
          fallbackEligible: true,
          message: "memo full",
          nodeCount: 1_835_019,
          retryable: true,
        });
      }
      return {
        possible: true,
        stats: { solverBackend: "rust-phase2", solveMs: 5 },
      };
    });
    const preemptValidationForNextRung = vi.fn(() => null);
    const resetFailedWorker = vi.fn(() => null);

    const recovered = await solveWithClientRecovery({
      input: INPUT,
      onProgress: () => undefined,
      preemptValidationForNextRung,
      primaryBackend: "rust-min-ef",
      requestWorkerTask,
      resetFailedWorker,
    });

    expect(calls).toEqual([
      { backend: "rust-min-ef", payload: undefined },
      {
        backend: "rust-phase2",
        payload: { phase2MemoTier: 22, phase2RetryOnMemoFull: false },
      },
    ]);
    expect(preemptValidationForNextRung).toHaveBeenCalledOnce();
    expect(resetFailedWorker).toHaveBeenCalledOnce();
    expect(preemptValidationForNextRung.mock.invocationCallOrder[0]).toBeLessThan(
      resetFailedWorker.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(recovered.result.stats).toMatchObject({
      attemptedStates: 1_835_019,
      fallbackFrom: "rust-min-ef",
      fallbackReason: "memo_full",
      solverBackend: "rust-phase2",
      workerErrorCode: "memo_full",
    });
    expect(recovered.trace).toEqual({
      jsExit: "not_attempted",
      minEfExit: "memo_full",
      phase2Exit: "success",
      policyVersion: "ladder_v1",
      requestedBackend: "rust-min-ef",
      terminalBackend: "rust-phase2",
      terminalOutcome: "success",
    });
  });

  it("does not send a heavy early-game input to JS after a deployment failure", async () => {
    const error = new WorkerTaskError({
      code: "wasm_load_failed",
      fallbackEligible: true,
      message: "WASM failed",
      retryable: true,
    });
    const requestWorkerTask: WorkerTaskRequester = vi.fn(async () => {
      throw error;
    });

    await expect(
      solveWithClientRecovery({
        input: INPUT,
        onProgress: () => undefined,
        preemptValidationForNextRung: () => null,
        primaryBackend: "rust-min-ef",
        requestWorkerTask,
        resetFailedWorker: () => null,
      }),
    ).rejects.toMatchObject({
      trace: {
        minEfExit: "wasm_load_failed",
        terminalBackend: "rust-min-ef",
        terminalOutcome: "failure",
      },
      workerError: error,
    });
    expect(requestWorkerTask).toHaveBeenCalledOnce();
  });

  it("does not start a rung after the absolute recovery deadline", async () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(1_000).mockReturnValue(26_001);
    const requestWorkerTask: WorkerTaskRequester = vi.fn(async () => ({ possible: true }));
    const preemptValidationForNextRung = vi.fn(() => null);
    const resetFailedWorker = vi.fn(() => null);

    try {
      await expect(
        solveWithClientRecovery({
          input: INPUT,
          onProgress: () => undefined,
          preemptValidationForNextRung,
          primaryBackend: "rust-min-ef",
          requestWorkerTask,
          resetFailedWorker,
        }),
      ).rejects.toMatchObject({
        trace: {
          minEfExit: "worker_timeout",
          terminalBackend: "rust-min-ef",
          terminalOutcome: "failure",
        },
      });
      expect(requestWorkerTask).not.toHaveBeenCalled();
      expect(preemptValidationForNextRung).not.toHaveBeenCalled();
      expect(resetFailedWorker).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});
