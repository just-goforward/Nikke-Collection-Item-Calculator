import { asRecord, field, normalizeState } from "./event-validation-common";
import type {
  SubmissionEnvelope,
  UnknownRecord,
  ValidatedSubmission,
} from "./event-validation-types";
import { normalizeDiagnosticToken, normalizeSourceHost, normalizeStrategy } from "./normalization";

export function validateDiagnosticSubmission(
  payload: SubmissionEnvelope,
  event: UnknownRecord,
): ValidatedSubmission {
  const stockBuckets = asRecord(field(event, "stockBuckets"), "invalid_stock_buckets");
  return {
    eventId: payload.eventId,
    sourceHost: normalizeSourceHost(payload.sourceHost),
    event: {
      kind: "solver_diagnostic",
      diagnosticVersion: field(event, "diagnosticVersion"),
      solverVersion: normalizeDiagnosticToken(field(event, "solverVersion")),
      solverPhase: normalizeDiagnosticToken(field(event, "solverPhase")),
      start: normalizeState(field(event, "start"), false),
      strategy: normalizeStrategy(field(event, "strategy")),
      stockBuckets: {
        blue: field(stockBuckets, "blue"),
        purple: field(stockBuckets, "purple"),
        yellow: field(stockBuckets, "yellow"),
      },
      recommendedKit: field(event, "recommendedKit"),
      recommendedUsesBucket: field(event, "recommendedUsesBucket"),
      candidateCountBucket: field(event, "candidateCountBucket"),
      probabilityGapBucket: field(event, "probabilityGapBucket"),
      resourceCostBucket: field(event, "resourceCostBucket"),
      legacySupplyCostBucket: field(event, "legacySupplyCostBucket"),
      totalExpectedCostBucket: field(event, "totalExpectedCostBucket"),
      blueShareBucket: field(event, "blueShareBucket"),
      minAutonomyDaysBucket: field(event, "minAutonomyDaysBucket"),
      nodeCountBucket: normalizeDiagnosticToken(field(event, "nodeCountBucket")),
      changedFromSingle: field(event, "changedFromSingle"),
      changedFromLegacySupply: field(event, "changedFromLegacySupply"),
      legacyPrivateStatsAvailable: Boolean(field(event, "legacyPrivateStatsAvailable")),
      legacyEventAggregateMatchable: Boolean(field(event, "legacyEventAggregateMatchable")),
    },
  };
}
