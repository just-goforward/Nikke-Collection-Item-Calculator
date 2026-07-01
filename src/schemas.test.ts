import { describe, expect, it } from "vitest";

import { StatsApiResponseSchema, WorkerRequestSchema, WorkerResponseSchema } from "./schemas";

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

describe("WorkerRequestSchema", () => {
  const input = {
    start: { grade: "R", level: 0, exp: 0 },
    stock: { blue: 100, purple: 50, yellow: 30 },
  };

  it("requires an explicit solver backend", () => {
    expect(
      WorkerRequestSchema.safeParse({
        type: "solve",
        id: 1,
        input,
      }).success,
    ).toBe(false);
  });

  it("accepts a solve request with backend and wasm URL", () => {
    const parsed = WorkerRequestSchema.parse({
      type: "solve",
      id: 1,
      backend: "rust-min-ef",
      wasmUrl: "/solver_rs.wasm",
      input,
    });

    expect(parsed.backend).toBe("rust-min-ef");
    expect(parsed.wasmUrl).toBe("/solver_rs.wasm");
  });
});

describe("WorkerResponseSchema", () => {
  it("requires structured worker error details", () => {
    expect(
      WorkerResponseSchema.safeParse({
        type: "error",
        id: 1,
        message: "failed",
      }).success,
    ).toBe(false);
  });

  it("accepts a typed worker error response", () => {
    const parsed = WorkerResponseSchema.parse({
      type: "error",
      id: 1,
      code: "rust_timeout",
      message: "Rust solver timed out.",
      retryable: true,
      fallbackEligible: true,
    });

    expect(parsed.code).toBe("rust_timeout");
    expect(parsed.fallbackEligible).toBe(true);
  });
});
