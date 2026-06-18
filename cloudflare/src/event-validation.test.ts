import { describe, expect, it } from "vitest";
import { validatePayload } from "./event-validation";
import { HttpError } from "./http-error";

function kitPayload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    eventId: "kit-result-valid-0001",
    sourceHost: "www.Example.com",
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
    expect(validatePayload(kitPayload())).toMatchObject({
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

  it("rejects a failed result state that does not match recommended uses", () => {
    expectHttpError(
      () =>
        validatePayload(
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
        validatePayload(
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

  it("normalizes diagnostic tokens and booleans", () => {
    const result = validatePayload({
      version: 1,
      eventId: "solver-diag-valid-001",
      sourceHost: "direct",
      event: {
        kind: "solver_diagnostic",
        diagnosticVersion: 4,
        solverVersion: "phase3_rust-min.ef",
        solverPhase: "bad phase",
        solverBackend: "rust-min-ef",
        fallbackFrom: "rust-min-ef",
        fallbackReason: "memo_full",
        start: { grade: "SR", level: 1, exp: 0 },
        strategy: "other",
        stockBuckets: { blue: "300_349", purple: "150_199", yellow: "50_99" },
        recommendedKit: "blue",
        recommendedUsesBucket: "5_9",
        candidateCountBucket: "3_plus",
        probabilityGapBucket: "0_1_0_3pp",
        resourceCostBucket: "0_1_0_25",
        nodeCountBucket: "100000_499999",
        solveMsBucket: "100_250",
        legacySupplyCostBucket: "0_1_0_25",
        totalExpectedCostBucket: "100_199",
        blueShareBucket: "50_70",
        minAutonomyDaysBucket: "14_28",
        changedFromSingle: "yes",
        changedFromLegacySupply: "no",
        legacyPrivateStatsAvailable: 1,
        legacyEventAggregateMatchable: 0,
      },
    });

    expect(result.event).toMatchObject({
      kind: "solver_diagnostic",
      solverVersion: "phase3_rust-min.ef",
      solverPhase: "unknown",
      solverBackend: "rust-min-ef",
      fallbackFrom: "rust-min-ef",
      fallbackReason: "memo_full",
      strategy: "unknown",
      nodeCountBucket: "100000_499999",
      solveMsBucket: "100_250",
      legacyPrivateStatsAvailable: true,
      legacyEventAggregateMatchable: false,
    });
  });
});
