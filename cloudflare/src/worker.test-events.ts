export const TEST_TURNSTILE_TOKEN = "valid-turnstile-token-for-tests";

export function kitResultEvent(eventId: string) {
  return {
    version: 1,
    eventId,
    sourceHost: "test.example",
    turnstileToken: TEST_TURNSTILE_TOKEN,
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
    },
  };
}

export function solverDiagnosticEvent(eventId: string) {
  return {
    version: 1,
    eventId,
    sourceHost: "test.example",
    turnstileToken: TEST_TURNSTILE_TOKEN,
    event: {
      kind: "solver_diagnostic",
      diagnosticVersion: 1,
      solverVersion: "phase1",
      solverPhase: "phase1",
      start: { grade: "SR", level: 1, exp: 0 },
      strategy: "supply",
      stockBuckets: { blue: "100_299", purple: "50_99", yellow: "10_49" },
      recommendedKit: "blue",
      recommendedUsesBucket: "5_9",
      candidateCountBucket: "3_plus",
      probabilityGapBucket: "0_1_0_3pp",
      resourceCostBucket: "0_1_0_25",
      legacySupplyCostBucket: "0_1_0_25",
      totalExpectedCostBucket: "100_199",
      blueShareBucket: "50_70",
      minAutonomyDaysBucket: "14_28",
      changedFromSingle: "yes",
      changedFromLegacySupply: "no",
      legacyPrivateStatsAvailable: true,
      legacyEventAggregateMatchable: false,
    },
  };
}
