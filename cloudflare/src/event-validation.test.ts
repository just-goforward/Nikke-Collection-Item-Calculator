import { describe, expect, it } from "vitest";
import { validatePayload } from "./event-validation";
import { HttpError } from "./http-error";
import { EventSubmissionSchema } from "./schemas";
import {
  runtimeInvariantEvent,
  solverDiagnosticEvent,
  solverRecoveryEvent,
} from "./worker.test-events";

function kitPayload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    eventId: "kit-result-valid-0001",
    sourceHost: "www.Example.com",
    turnstileToken: "test-turnstile-token-value",
    event: {
      kind: "kit_result",
      start: { grade: "R", level: 0, exp: 0 },
      kit: "blue",
      recommendedUses: 1,
      strategy: "supply",
      outcome: "no_great_success",
      successAttempt: null,
      stockBefore: { blue: 10, purple: 0, yellow: 0 },
      stockAfter: { blue: 0, purple: 0, yellow: 0 },
      resultState: { grade: "R", level: 0, exp: 200 },
      ...overrides,
    },
  };
}

function validateTestPayload(payload: unknown) {
  return validatePayload(EventSubmissionSchema.parse(payload));
}

function expectHttpError(action: () => unknown, message: string) {
  expect(action).toThrow(HttpError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ status: 400, message });
  }
}

describe("validatePayload", () => {
  it("normalizes a valid kit result event", () => {
    expect(validateTestPayload(kitPayload())).toMatchObject({
      eventId: "kit-result-valid-0001",
      sourceHost: "example.com",
      event: {
        kind: "kit_result",
        kit: "blue",
        recommendedUses: 1,
        outcome: "no_great_success",
        successAttempt: null,
      },
    });
  });

  it("preserves allowed passthrough fields while accepting optional and nullable values", () => {
    const payload = kitPayload({
      futureEventField: "kept",
      strategy: undefined,
      successAttempt: null,
    });
    Object.assign(payload, { futureEnvelopeField: 42 });

    const parsed = EventSubmissionSchema.parse(payload);

    expect(parsed).toMatchObject({
      futureEnvelopeField: 42,
      event: {
        futureEventField: "kept",
        successAttempt: null,
      },
    });
  });

  it("rejects a failed result state that does not match recommended uses", () => {
    expectHttpError(
      () =>
        validateTestPayload(
          kitPayload({
            resultState: { grade: "R", level: 0, exp: 400 },
          }),
        ),
      "invalid_fail_result_state",
    );
  });

  it("rejects success attempts that do not match stock delta", () => {
    expectHttpError(
      () =>
        validateTestPayload(
          kitPayload({
            outcome: "great_success",
            successAttempt: 2,
            recommendedUses: 2,
            stockBefore: { blue: 10, purple: 0, yellow: 0 },
            stockAfter: { blue: 0, purple: 0, yellow: 0 },
            resultState: { grade: "R", level: 5, exp: 0 },
          }),
        ),
      "stock_delta_does_not_match_success_attempt",
    );
  });

  it("normalizes diagnostic tokens and preserves validated booleans", () => {
    const result = validateTestPayload({
      version: 1,
      eventId: "solver-diag-valid-001",
      sourceHost: "direct",
      turnstileToken: "test-turnstile-token-value",
      event: {
        kind: "solver_diagnostic",
        diagnosticVersion: 4,
        solverVersion: "phase3_rust-min.ef",
        solverPhase: "bad phase",
        solverBackend: "rust-min-ef",
        fallbackFrom: "rust-min-ef",
        fallbackReason: "memo_full",
        memoryStrategy: "balanced-v1",
        minEfMemoTier: "21",
        phase2MemoTier: "22",
        phase2MemoRetried: "no",
        start: { grade: "SR", level: 1, exp: 0 },
        strategy: "supply",
        stockBuckets: { blue: "300_349", purple: "150_199", yellow: "50_99" },
        recommendedKit: "blue",
        recommendedUsesBucket: "5_9",
        candidateCountBucket: "3_plus",
        probabilityGapBucket: "0_1_0_3pp",
        resourceCostBucket: "0_1_0_25",
        nodeCountBucket: "100000_499999",
        attemptedNodeCountBucket: "500000_999999",
        solveMsBucket: "100_250",
        legacySupplyCostBucket: "0_1_0_25",
        totalExpectedCostBucket: "100_199",
        blueShareBucket: "50_70",
        minAutonomyDaysBucket: "14_28",
        changedFromSingle: "yes",
        changedFromLegacySupply: "no",
        legacyPrivateStatsAvailable: true,
        legacyEventAggregateMatchable: false,
      },
    });

    expect(result.event).toMatchObject({
      kind: "solver_diagnostic",
      solverVersion: "phase3_rust-min.ef",
      solverPhase: "unknown",
      solverBackend: "rust-min-ef",
      fallbackFrom: "rust-min-ef",
      fallbackReason: "memo_full",
      memoryStrategy: "balanced-v1",
      minEfMemoTier: "21",
      phase2MemoTier: "22",
      phase2MemoRetried: "no",
      strategy: "supply",
      nodeCountBucket: "100000_499999",
      attemptedNodeCountBucket: "500000_999999",
      solveMsBucket: "100_250",
      legacyPrivateStatsAvailable: true,
      legacyEventAggregateMatchable: false,
    });
  });

  it("rejects invalid primitive field types at the Zod boundary", () => {
    const payload = kitPayload({ recommendedUses: "1" });
    expect(EventSubmissionSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts supported calculation locales and rejects unknown locale values", () => {
    const valid = solverDiagnosticEvent("solver-locale-valid01");
    valid.event.locale = "ja";
    expect(validateTestPayload(valid).event).toMatchObject({ locale: "ja" });

    const invalid = solverDiagnosticEvent("solver-locale-invalid1");
    invalid.event.locale = "fr";
    expect(EventSubmissionSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts supported diagnostic versions and rejects unknown future versions", () => {
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
      const supported = solverDiagnosticEvent(`solver-version-${version}-valid01`);
      supported.event.diagnosticVersion = version;
      expect(EventSubmissionSchema.safeParse(supported).success).toBe(true);
    }

    const future = solverDiagnosticEvent("solver-version-future01");
    future.event.diagnosticVersion = 9;
    expect(EventSubmissionSchema.safeParse(future).success).toBe(false);
  });

  it("accepts only enumerated runtime invariant fields", () => {
    const valid = runtimeInvariantEvent("runtime-invariant-valid1");
    expect(validateTestPayload(valid).event).toEqual(valid.event);

    const withRawError = runtimeInvariantEvent("runtime-invariant-raw001");
    Object.assign(withRawError.event, { rawError: "private stack trace" });
    expect(EventSubmissionSchema.safeParse(withRawError).success).toBe(false);

    const unknownCode = runtimeInvariantEvent("runtime-invariant-code01");
    unknownCode.event.code = "arbitrary_invariant";
    expect(EventSubmissionSchema.safeParse(unknownCode).success).toBe(false);
  });
});

describe("supply forecast identity validation", () => {
  it("requires a registered supply forecast for current diagnostics", () => {
    const missing = solverDiagnosticEvent("solver-forecast-missing01");
    Reflect.deleteProperty(missing.event, "forecastId");
    expect(() => validateTestPayload(missing)).toThrow("invalid_supply_forecast");

    const unknown = solverDiagnosticEvent("solver-forecast-unknown01");
    Reflect.set(unknown.event, "forecastId", "supply-2099-01-01-v1");
    expect(() => validateTestPayload(unknown)).toThrow("invalid_supply_forecast");
  });

  it("requires a registered profile for current diagnostics", () => {
    const missing = solverDiagnosticEvent("solver-profile-missing001");
    Reflect.deleteProperty(missing.event, "forecastProfileId");
    expect(() => validateTestPayload(missing)).toThrow("invalid_supply_forecast_profile");

    const unknown = solverDiagnosticEvent("solver-profile-unknown001");
    Reflect.set(unknown.event, "forecastProfileId", "supply-2099-01-01-v1@unknown");
    expect(() => validateTestPayload(unknown)).toThrow("invalid_supply_forecast_profile");
  });

  it("maps unversioned legacy diagnostics to the legacy forecast identity", () => {
    const legacy = solverDiagnosticEvent("solver-forecast-legacy001");
    legacy.event.diagnosticVersion = 6;
    Reflect.deleteProperty(legacy.event, "forecastId");
    Reflect.deleteProperty(legacy.event, "forecastProfileId");

    expect(validateTestPayload(legacy).event).toMatchObject({
      forecastId: "legacy-unversioned",
      forecastProfileId: "legacy-unversioned-profile",
    });
  });

  it("validates recovery forecast identities without breaking legacy clients", () => {
    const current = solverRecoveryEvent("recovery-forecast-current01");
    expect(validateTestPayload(current).event).toMatchObject({
      forecastId: "supply-2026-08-21-v1",
      forecastProfileId: "supply-2026-08-21-v1@fixed",
    });

    const legacy = solverRecoveryEvent("recovery-forecast-legacy001");
    Reflect.deleteProperty(legacy.event, "forecastId");
    Reflect.deleteProperty(legacy.event, "forecastProfileId");
    expect(validateTestPayload(legacy).event).toMatchObject({
      forecastId: "legacy-unversioned",
      forecastProfileId: "legacy-unversioned-profile",
    });

    const unknown = solverRecoveryEvent("recovery-forecast-unknown01");
    Reflect.set(unknown.event, "forecastId", "supply-2099-01-01-v1");
    expect(() => validateTestPayload(unknown)).toThrow("invalid_supply_forecast");
  });
});

describe("kit-result attempt probability contract", () => {
  it("accepts a recommendation whose final failed attempt reaches the next level", () => {
    expect(
      validateTestPayload(
        kitPayload({
          recommendedUses: 5,
          stockBefore: { blue: 50, purple: 0, yellow: 0 },
          stockAfter: { blue: 0, purple: 0, yellow: 0 },
          resultState: { grade: "R", level: 1, exp: 0 },
        }),
      ),
    ).toMatchObject({ event: { recommendedUses: 5 } });
  });

  it("rejects attempts that continue after a failed attempt changes level", () => {
    expectHttpError(
      () =>
        validateTestPayload(
          kitPayload({
            recommendedUses: 6,
            stockBefore: { blue: 60, purple: 0, yellow: 0 },
            stockAfter: { blue: 0, purple: 0, yellow: 0 },
            resultState: { grade: "R", level: 1, exp: 200 },
          }),
        ),
      "attempts_cross_level_boundary",
    );
  });

  it("rejects a reported success after an earlier failure crossed a level boundary", () => {
    expectHttpError(
      () =>
        validateTestPayload(
          kitPayload({
            outcome: "great_success",
            successAttempt: 6,
            recommendedUses: 6,
            stockBefore: { blue: 60, purple: 0, yellow: 0 },
            stockAfter: { blue: 0, purple: 0, yellow: 0 },
            resultState: { grade: "R", level: 5, exp: 0 },
          }),
        ),
      "attempts_cross_level_boundary",
    );
  });
});
