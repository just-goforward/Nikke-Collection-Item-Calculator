import { validateState } from "./event-validation-common";
import type { SubmissionEnvelope, ValidatedSubmission } from "./event-validation-types";
import { normalizeDiagnosticToken, normalizeSourceHost, normalizeStrategy } from "./normalization";
import type { SolverDiagnosticEventInput } from "./schemas";

export function validateDiagnosticSubmission(
  payload: SubmissionEnvelope,
  event: SolverDiagnosticEventInput,
): ValidatedSubmission {
  return {
    eventId: payload.eventId,
    sourceHost: normalizeSourceHost(payload.sourceHost),
    event: {
      kind: "solver_diagnostic",
      diagnosticVersion: event.diagnosticVersion,
      solverVersion: normalizeDiagnosticToken(event.solverVersion),
      solverPhase: normalizeDiagnosticToken(event.solverPhase),
      solverBackend: normalizeDiagnosticToken(event.solverBackend),
      fallbackFrom: normalizeOptionalDiagnosticToken(event.fallbackFrom, "none"),
      fallbackReason: normalizeOptionalDiagnosticToken(event.fallbackReason, "none"),
      start: validateState(event.start, false),
      strategy: normalizeStrategy(event.strategy),
      stockBuckets: event.stockBuckets,
      recommendedKit: event.recommendedKit,
      recommendedUsesBucket: event.recommendedUsesBucket,
      candidateCountBucket: event.candidateCountBucket,
      probabilityGapBucket: event.probabilityGapBucket,
      resourceCostBucket: event.resourceCostBucket,
      legacySupplyCostBucket: event.legacySupplyCostBucket,
      totalExpectedCostBucket: event.totalExpectedCostBucket,
      blueShareBucket: event.blueShareBucket,
      minAutonomyDaysBucket: event.minAutonomyDaysBucket,
      nodeCountBucket: normalizeDiagnosticToken(event.nodeCountBucket),
      attemptedNodeCountBucket: normalizeDiagnosticToken(event.attemptedNodeCountBucket),
      solveMsBucket: normalizeOptionalDiagnosticToken(event.solveMsBucket, "unknown"),
      changedFromSingle: event.changedFromSingle,
      changedFromLegacySupply: event.changedFromLegacySupply,
      legacyPrivateStatsAvailable: event.legacyPrivateStatsAvailable,
      legacyEventAggregateMatchable: event.legacyEventAggregateMatchable,
    },
  };
}

function normalizeOptionalDiagnosticToken(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return normalizeDiagnosticToken(value);
}
