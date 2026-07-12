import { describe, expect, it } from "vitest";

import { parseWorkerRequest, parseWorkerResponse } from "../shared/workerProtocol";
import { StatsApiResponseSchema } from "./schemas";

const baseResponse = {
  windowDays: 0,
  today: "2026-05-26",
  summary: {
    events: 0,
    attempts: 0,
    greatSuccesses: 0,
    greatSuccessRate: 0,
    todayEvents: 0,
    todayAttempts: 0,
    todayGreatSuccesses: 0,
    mostUsedKit: null,
    mostUsedKitPieces: 0,
  },
  byKit: [],
  cumulative: {
    summary: { events: 0, attempts: 0, greatSuccesses: 0, greatSuccessRate: 0 },
    byKit: [],
  },
  segmentStats: [],
};

describe("StatsApiResponseSchema", () => {
  it("defaults removed legacy statistics arrays when a compatible worker omits them", () => {
    const parsed = StatsApiResponseSchema.parse(baseResponse);

    expect(parsed.levelKitStats).toEqual([]);
    expect(parsed.successAttemptDistribution).toEqual([]);
  });

  it("accepts compatibility placeholders from the worker", () => {
    const parsed = StatsApiResponseSchema.parse({
      ...baseResponse,
      levelKitStats: [],
      successAttemptDistribution: [],
    });

    expect(parsed.levelKitStats).toEqual([]);
    expect(parsed.successAttemptDistribution).toEqual([]);
  });
});

describe("worker request protocol", () => {
  const input = {
    start: { grade: "R", level: 0, exp: 0 },
    stock: { blue: 100, purple: 50, yellow: 30 },
  };

  it("requires an explicit solver backend", () => {
    expect(
      parseWorkerRequest({
        type: "solve",
        id: 1,
        input,
      }).success,
    ).toBe(false);
  });

  it("accepts a solve request with backend and wasm URL", () => {
    const parsed = parseWorkerRequest({
      type: "solve",
      id: 1,
      backend: "rust-min-ef",
      wasmUrl: "/solver_rs.wasm",
      input,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Expected a valid worker request.");
    expect(parsed.data.backend).toBe("rust-min-ef");
    expect(parsed.data.wasmUrl).toBe("/solver_rs.wasm");
  });
});

describe("worker response protocol", () => {
  it("requires structured worker error details", () => {
    expect(
      parseWorkerResponse({
        type: "error",
        id: 1,
        message: "failed",
      }).success,
    ).toBe(false);
  });

  it("accepts a typed worker error response", () => {
    const parsed = parseWorkerResponse({
      type: "error",
      id: 1,
      code: "rust_timeout",
      message: "Rust solver timed out.",
      retryable: true,
      fallbackEligible: true,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.type !== "error")
      throw new Error("Expected a valid worker error response.");
    expect(parsed.data.code).toBe("rust_timeout");
    expect(parsed.data.fallbackEligible).toBe(true);
  });

  it("accepts a non-fallback stale handle response", () => {
    const parsed = parseWorkerResponse({
      type: "error",
      id: 2,
      code: "stale_handle",
      message: "stale policy handle",
      retryable: false,
      fallbackEligible: false,
    });

    expect(parsed).toEqual({
      success: true,
      data: {
        type: "error",
        id: 2,
        code: "stale_handle",
        message: "stale policy handle",
        retryable: false,
        fallbackEligible: false,
      },
    });
  });

  it("accepts measured result timing and rejects negative durations", () => {
    expect(
      parseWorkerResponse({
        type: "result",
        id: 3,
        result: { ok: true },
        timing: { queueWaitMs: 12.5, executionMs: 40 },
      }),
    ).toEqual({
      success: true,
      data: {
        type: "result",
        id: 3,
        result: { ok: true },
        timing: { queueWaitMs: 12.5, executionMs: 40 },
      },
    });
    expect(
      parseWorkerResponse({
        type: "result",
        id: 4,
        result: null,
        timing: { queueWaitMs: -1, executionMs: 40 },
      }).success,
    ).toBe(false);
  });

  it("rejects local cancellation codes received over the worker wire", () => {
    const parsed = parseWorkerResponse({
      type: "error",
      id: 5,
      code: "task_cancelled",
      message: "validation preempted",
      retryable: false,
      fallbackEligible: false,
    });

    expect(parsed.success).toBe(false);
  });
});
