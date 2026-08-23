import { describe, expect, it, vi } from "vitest";
import { WorkerTaskCancelled, WorkerTaskError } from "./solverWorkerClient";
import { makeSolveCacheKey, readSolveCache, resolveWorkerOrFallback } from "./useSolverWorker";

describe("resolveWorkerOrFallback", () => {
  it("uses the fallback for an eligible worker error", async () => {
    const fallback = vi.fn(async () => "js-result");
    const error = new WorkerTaskError({
      code: "rust_timeout",
      fallbackEligible: true,
      message: "timed out",
      retryable: true,
    });

    await expect(
      resolveWorkerOrFallback({
        fallback,
        workerPromise: Promise.reject(error),
      }),
    ).resolves.toEqual({ result: "js-result", workerError: error });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("surfaces a stale policy error instead of hiding it behind JS fallback", async () => {
    const fallback = vi.fn(async () => "js-result");
    const error = new WorkerTaskError({
      code: "stale_handle",
      fallbackEligible: false,
      message: "stale policy handle",
      retryable: false,
    });

    await expect(
      resolveWorkerOrFallback({
        fallback,
        workerPromise: Promise.reject(error),
      }),
    ).rejects.toBe(error);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("honors an explicit no-fallback worker error", async () => {
    const fallback = vi.fn(async () => "js-result");
    const error = new WorkerTaskError({
      code: "wasm_load_failed",
      fallbackEligible: false,
      message: "WASM loading is disabled for this request",
      retryable: false,
    });

    await expect(
      resolveWorkerOrFallback({
        fallback,
        workerPromise: Promise.reject(error),
      }),
    ).rejects.toBe(error);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("passes local cancellation through without converting it to a JS fallback", async () => {
    const fallback = vi.fn(async () => "js-result");
    const cancellation = new WorkerTaskCancelled({
      reason: "validation_preempted",
      task: "validate",
    });

    await expect(
      resolveWorkerOrFallback({
        fallback,
        workerPromise: Promise.reject(cancellation),
      }),
    ).rejects.toBe(cancellation);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does not silently downgrade unexpected failures", async () => {
    const fallback = vi.fn(async () => "js-result");
    const unexpected = new Error("unexpected client failure");

    await expect(
      resolveWorkerOrFallback({
        fallback,
        workerPromise: Promise.reject(unexpected),
      }),
    ).rejects.toBe(unexpected);
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe("readSolveCache", () => {
  it("returns cache metadata without mutating the stored solver result", () => {
    const result = { possible: true, stats: { solveMs: 123 } };
    const cache = new Map([["rust-min-ef|input", result]]);

    expect(readSolveCache(cache, "rust-min-ef|input", "rust-min-ef")).toEqual({
      executionKind: "cache_hit",
      requestedBackend: "rust-min-ef",
      result,
    });
    expect(cache.get("rust-min-ef|input")).toBe(result);
    expect(result.stats).toEqual({ solveMs: 123 });
  });

  it("keeps identical inputs isolated by requested backend", () => {
    const input = {
      start: { grade: "SR" as const, level: 10, exp: 0 },
      stock: { blue: 100, purple: 100, yellow: 100 },
      strategy: "supply" as const,
    };
    const rustKey = makeSolveCacheKey("rust-min-ef", input);
    const phase2Key = makeSolveCacheKey("rust-phase2", input);
    const result = { possible: true };
    const cache = new Map([[rustKey, result]]);

    expect(rustKey).toContain("supply-2026-08-21-v1|");
    expect(phase2Key).not.toBe(rustKey);
    expect(readSolveCache(cache, phase2Key, "rust-phase2")).toBeNull();
    expect(readSolveCache(cache, rustKey, "rust-min-ef")?.result).toBe(result);
  });
});
