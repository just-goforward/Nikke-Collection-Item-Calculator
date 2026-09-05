import { describe, expect, it, vi } from "vitest";

import { WORKER_ERROR_CODES, type WorkerErrorCode } from "../../shared/workerProtocol";
import {
  decideSolveRecovery,
  isLightweightJsInput,
  RUST_PHASE2_RUNG_TIMEOUT_MS,
  RUST_RUNG_TIMEOUT_MS,
  remainingDeadlineMs,
  SOLVE_DEADLINE_MS,
  WORKER_ERROR_TRAITS,
} from "./solverRecoveryPolicy";

const BACKENDS = ["rust-min-ef", "rust-phase2", "js-phase2"] as const;
const INTEGRITY_ERRORS: readonly WorkerErrorCode[] = [
  "invalid_worker_payload",
  "invalid_worker_response",
  "solve_in_flight",
  "stale_handle",
  "unknown_rust_status",
];
const CAPACITY_ERRORS = [
  "budget_exceeded",
  "memo_full",
  "memory_limit",
  "rust_timeout",
  "worker_queue_timeout",
  "worker_timeout",
] as const;
const BASE_RECOVERY = {
  attemptedBackend: "rust-min-ef",
  errorCode: "missing_export",
  fallbackEligible: true,
  jsInputAllowed: true,
  remainingMs: 1,
} as const;
const NO_FALLBACK = { action: "fail", reason: "no_safe_fallback" } as const;

describe("worker error trait contract", () => {
  it.each([
    ["budget_exceeded", "capacity", true],
    ["invalid_worker_payload", "integrity", false],
    ["invalid_worker_response", "integrity", false],
    ["memo_full", "capacity", true],
    ["memory_limit", "capacity", false],
    ["missing_export", "deployment", true],
    ["rust_timeout", "capacity", true],
    ["solve_in_flight", "invariant", false],
    ["stale_handle", "integrity", false],
    ["unknown_rust_status", "integrity", false],
    ["wasm_load_failed", "infrastructure", true],
    ["wasm_trap", "runtime", false],
    ["wasm_url_missing", "deployment", true],
    ["worker_error", "infrastructure", true],
    ["worker_queue_timeout", "capacity", true],
    ["worker_timeout", "capacity", true],
    ["worker_unavailable", "infrastructure", true],
  ] as const)("preserves %s classification and JS safety", (code, category, jsSemanticallySafe) => {
    expect(WORKER_ERROR_TRAITS[code]).toEqual({ category, jsSemanticallySafe });
  });

  it("preserves the absolute deadline and per-rung timeout budgets", () => {
    expect(SOLVE_DEADLINE_MS).toBe(45_000);
    expect(RUST_RUNG_TIMEOUT_MS).toBe(15_000);
    expect(RUST_PHASE2_RUNG_TIMEOUT_MS).toBe(25_000);
  });
});

describe("recovery decision guard order", () => {
  it.each([0, -1])("stops every backend and error at %s remaining milliseconds", (remainingMs) => {
    for (const attemptedBackend of BACKENDS) {
      for (const errorCode of WORKER_ERROR_CODES) {
        expect(
          decideSolveRecovery({ ...BASE_RECOVERY, attemptedBackend, errorCode, remainingMs }),
        ).toEqual({ action: "fail", reason: "deadline" });
      }
    }
  });

  it.each(INTEGRITY_ERRORS)("never retries or downgrades %s", (errorCode) => {
    for (const attemptedBackend of BACKENDS) {
      for (const fallbackEligible of [false, true]) {
        for (const jsInputAllowed of [false, true]) {
          expect(
            decideSolveRecovery({
              ...BASE_RECOVERY,
              attemptedBackend,
              errorCode,
              fallbackEligible,
              jsInputAllowed,
            }),
          ).toEqual({ action: "fail", reason: "integrity" });
        }
      }
    }
  });

  it.each(WORKER_ERROR_CODES)("honors a no-fallback result for %s", (errorCode) => {
    for (const attemptedBackend of BACKENDS) {
      expect(
        decideSolveRecovery({
          ...BASE_RECOVERY,
          attemptedBackend,
          errorCode,
          fallbackEligible: false,
        }),
      ).toEqual(
        INTEGRITY_ERRORS.includes(errorCode)
          ? { action: "fail", reason: "integrity" }
          : NO_FALLBACK,
      );
    }
  });
});

describe("recovery backend routing", () => {
  it.each(CAPACITY_ERRORS)("allows only the min-E[f] to phase2 transition for %s", (errorCode) => {
    for (const attemptedBackend of BACKENDS) {
      for (const jsInputAllowed of [false, true]) {
        expect(
          decideSolveRecovery({ ...BASE_RECOVERY, attemptedBackend, errorCode, jsInputAllowed }),
        ).toEqual(attemptedBackend === "rust-min-ef" ? { action: "retry_phase2" } : NO_FALLBACK);
      }
    }
  });

  it("retries a min-E[f] worker error in phase2 even for a heavy input", () => {
    expect(
      decideSolveRecovery({
        ...BASE_RECOVERY,
        errorCode: "worker_error",
        jsInputAllowed: false,
      }),
    ).toEqual({ action: "retry_phase2" });
  });

  it.each(["missing_export", "wasm_url_missing", "wasm_load_failed"] as const)(
    "uses the JS worker for %s only when the input is allowed",
    (errorCode) => {
      for (const attemptedBackend of ["rust-min-ef", "rust-phase2"] as const) {
        for (const jsInputAllowed of [false, true]) {
          expect(
            decideSolveRecovery({ ...BASE_RECOVERY, attemptedBackend, errorCode, jsInputAllowed }),
          ).toEqual(jsInputAllowed ? { action: "run_js_worker" } : NO_FALLBACK);
        }
      }
    },
  );

  it("allows an eligible phase2 worker error to use the JS worker", () => {
    expect(
      decideSolveRecovery({
        ...BASE_RECOVERY,
        attemptedBackend: "rust-phase2",
        errorCode: "worker_error",
      }),
    ).toEqual({ action: "run_js_worker" });
  });

  it.each(BACKENDS)(
    "never retries a WASM trap from %s even when fallback is offered",
    (backend) => {
      expect(
        decideSolveRecovery({
          ...BASE_RECOVERY,
          attemptedBackend: backend,
          errorCode: "wasm_trap",
        }),
      ).toEqual(NO_FALLBACK);
    },
  );

  it.each(BACKENDS)(
    "uses the main thread from %s only for an allowed unavailable worker",
    (backend) => {
      for (const jsInputAllowed of [false, true]) {
        expect(
          decideSolveRecovery({
            ...BASE_RECOVERY,
            attemptedBackend: backend,
            errorCode: "worker_unavailable",
            jsInputAllowed,
          }),
        ).toEqual(jsInputAllowed ? { action: "run_js_main_thread" } : NO_FALLBACK);
      }
    },
  );

  it("does not loop a JS worker failure back into another worker", () => {
    for (const errorCode of WORKER_ERROR_CODES) {
      if (errorCode === "worker_unavailable" || INTEGRITY_ERRORS.includes(errorCode)) continue;
      expect(
        decideSolveRecovery({ ...BASE_RECOVERY, attemptedBackend: "js-phase2", errorCode }),
      ).toEqual(NO_FALLBACK);
    }
  });
});

describe("lightweight input and deadline boundaries", () => {
  const start = { grade: "R", level: 0, exp: 0 } as const;

  it.each(["blue", "purple", "yellow"] as const)(
    "floors %s stock independently and includes exactly twelve uses",
    (kit) => {
      for (const [pieces, allowed] of [
        [129, true],
        [130, false],
      ] as const) {
        expect(
          isLightweightJsInput({
            start,
            stock: { blue: 0, purple: 0, yellow: 0, [kit]: pieces },
            strategy: "supply",
          }),
        ).toBe(allowed);
      }
    },
  );

  it("sums whole uses across all three colors without pooling leftover pieces", () => {
    expect(
      isLightweightJsInput({
        start,
        stock: { blue: 49, purple: 49, yellow: 49 },
        strategy: "supply",
      }),
    ).toBe(true);
    expect(
      isLightweightJsInput({
        start,
        stock: { blue: 50, purple: 49, yellow: 49 },
        strategy: "supply",
      }),
    ).toBe(false);
  });

  it.each([
    [100, 90, 10],
    [100, 100, 0],
    [100, 101, 0],
    [100.5, 100, 0.5],
  ] as const)("clamps deadline %s at time %s to %s milliseconds", (deadlineAt, now, expected) => {
    expect(remainingDeadlineMs(deadlineAt, now)).toBe(expected);
  });

  it("uses the monotonic clock when no current time is provided", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(75);
    try {
      expect(remainingDeadlineMs(100)).toBe(25);
    } finally {
      clock.mockRestore();
    }
  });
});
