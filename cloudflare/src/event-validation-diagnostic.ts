import { isSupplyForecastId } from "../../shared/generated/supplyForecast";
import { LEGACY_SUPPLY_FORECAST_ID } from "../../shared/statsContract";
import { validateState } from "./event-validation-common";
import type { SubmissionEnvelope, ValidatedSubmission } from "./event-validation-types";
import { HttpError } from "./http-error";
import { normalizeDiagnosticToken, normalizeSourceHost, normalizeStrategy } from "./normalization";
import type { SolverDiagnosticEventInput } from "./schemas";

export function validateDiagnosticSubmission(
  payload: SubmissionEnvelope,
  event: SolverDiagnosticEventInput,
): ValidatedSubmission {
  const solverBackend = normalizeDiagnosticToken(event.solverBackend);
  const forecastId = validatedForecastId(event.diagnosticVersion, event.forecastId);
  return {
    eventId: payload.eventId,
    sourceHost: normalizeSourceHost(payload.sourceHost),
    event: {
      kind: "solver_diagnostic",
      diagnosticVersion: event.diagnosticVersion,
      forecastId,
      locale: event.locale ?? null,
      solverVersion: normalizeDiagnosticToken(event.solverVersion),
      solverPhase: normalizeDiagnosticToken(event.solverPhase),
      solverBackend,
      requestedBackend: normalizeOptionalDiagnosticToken(event.requestedBackend, solverBackend),
      executionKind: event.executionKind || "executed",
      fallbackFrom: normalizeOptionalDiagnosticToken(event.fallbackFrom, "none"),
      fallbackReason: normalizeOptionalDiagnosticToken(event.fallbackReason, "none"),
      workerErrorCode: normalizeOptionalDiagnosticToken(event.workerErrorCode, "none"),
      memoryStrategy: normalizeOptionalDiagnosticToken(event.memoryStrategy, "unknown"),
      minEfMemoTier: normalizeOptionalDiagnosticToken(event.minEfMemoTier, "unknown"),
      phase2MemoTier: normalizeOptionalDiagnosticToken(event.phase2MemoTier, "unknown"),
      phase2MemoRetried: normalizeOptionalDiagnosticToken(event.phase2MemoRetried, "unknown"),
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

function validatedForecastId(diagnosticVersion: number, value: unknown) {
  if (isSupplyForecastId(value)) return value;
  if (diagnosticVersion < 7 && (value === undefined || value === null)) {
    return LEGACY_SUPPLY_FORECAST_ID;
  }
  throw new HttpError(400, "invalid_supply_forecast");
}

function normalizeOptionalDiagnosticToken(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return normalizeDiagnosticToken(value);
}
