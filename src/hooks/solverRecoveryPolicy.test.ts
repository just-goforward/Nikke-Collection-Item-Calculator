import { describe, expect, it } from "vitest";

import {
  decideSolveRecovery,
  isLightweightJsInput,
  WORKER_ERROR_TRAITS,
} from "./solverRecoveryPolicy";

describe("solver recovery policy", () => {
  it("routes min-E[f] capacity failures to phase2", () => {
    for (const errorCode of ["memo_full", "budget_exceeded", "rust_timeout"] as const) {
      expect(
        decideSolveRecovery({
          attemptedBackend: "rust-min-ef",
          errorCode,
          fallbackEligible: true,
          jsInputAllowed: false,
          remainingMs: 10_000,
        }),
      ).toEqual({ action: "retry_phase2" });
    }
  });

  it("does not hide integrity failures or phase2 capacity failures", () => {
    expect(
      decideSolveRecovery({
        attemptedBackend: "rust-min-ef",
        errorCode: "invalid_worker_response",
        fallbackEligible: false,
        jsInputAllowed: true,
        remainingMs: 10_000,
      }),
    ).toEqual({ action: "fail", reason: "integrity" });
    expect(
      decideSolveRecovery({
        attemptedBackend: "rust-phase2",
        errorCode: "rust_timeout",
        fallbackEligible: true,
        jsInputAllowed: true,
        remainingMs: 10_000,
      }),
    ).toEqual({ action: "fail", reason: "no_safe_fallback" });
  });

  it("uses JS only for whitelisted inputs when Rust is unavailable", () => {
    for (const errorCode of ["wasm_load_failed", "wasm_url_missing", "missing_export"] as const) {
      expect(
        decideSolveRecovery({
          attemptedBackend: "rust-min-ef",
          errorCode,
          fallbackEligible: true,
          jsInputAllowed: true,
          remainingMs: 10_000,
        }),
      ).toEqual({ action: "run_js_worker" });
    }
    expect(
      decideSolveRecovery({
        attemptedBackend: "rust-min-ef",
        errorCode: "worker_unavailable",
        fallbackEligible: true,
        jsInputAllowed: true,
        remainingMs: 10_000,
      }),
    ).toEqual({ action: "run_js_main_thread" });
  });

  it("honors an explicit no-fallback worker result", () => {
    expect(
      decideSolveRecovery({
        attemptedBackend: "rust-min-ef",
        errorCode: "wasm_load_failed",
        fallbackEligible: false,
        jsInputAllowed: true,
        remainingMs: 10_000,
      }),
    ).toEqual({ action: "fail", reason: "no_safe_fallback" });
  });

  it("does not reinterpret a WASM trap as a recoverable contract error", () => {
    expect(
      decideSolveRecovery({
        attemptedBackend: "rust-min-ef",
        errorCode: "wasm_trap",
        fallbackEligible: false,
        jsInputAllowed: true,
        remainingMs: 10_000,
      }),
    ).toEqual({ action: "fail", reason: "no_safe_fallback" });
  });

  it("keeps the fallback whitelist conservative", () => {
    expect(
      isLightweightJsInput({
        start: { grade: "SR", level: 10, exp: 0 },
        stock: { blue: 300, purple: 150, yellow: 150 },
        strategy: "supply",
      }),
    ).toBe(true);
    expect(
      isLightweightJsInput({
        start: { grade: "R", level: 0, exp: 0 },
        stock: { blue: 300, purple: 150, yellow: 150 },
        strategy: "supply",
      }),
    ).toBe(false);
  });

  it("keeps the SR fallback boundary at level 8", () => {
    const stock = { blue: 300, purple: 150, yellow: 150 };
    expect(
      isLightweightJsInput({
        start: { grade: "SR", level: 7, exp: 0 },
        stock,
        strategy: "supply",
      }),
    ).toBe(false);
    expect(
      isLightweightJsInput({
        start: { grade: "SR", level: 8, exp: 0 },
        stock,
        strategy: "supply",
      }),
    ).toBe(true);
  });

  it("does not misclassify convertible R15 as a lightweight terminal state", () => {
    const stock = { blue: 300, purple: 150, yellow: 150 };
    expect(
      isLightweightJsInput({
        start: { grade: "SR", level: 15, exp: 0 },
        stock,
        strategy: "supply",
      }),
    ).toBe(true);
    expect(
      isLightweightJsInput({
        start: { grade: "R", level: 15, exp: 0 },
        stock,
        strategy: "supply",
      }),
    ).toBe(false);
  });

  it("defines a trait for every accepted Worker error code", () => {
    expect(Object.keys(WORKER_ERROR_TRAITS)).toHaveLength(16);
  });
});
