import {
  isSupplyForecastId,
  isSupplyForecastProfileId,
} from "../../shared/generated/supplyForecast";
import {
  LEGACY_RECOVERY_REVISION,
  LEGACY_RECOVERY_SOLVER_VERSIONS,
} from "../../shared/solverRecoveryContract";
import {
  LEGACY_SUPPLY_FORECAST_ID,
  LEGACY_SUPPLY_FORECAST_PROFILE_ID,
} from "../../shared/statsContract";
import { validateState } from "./event-validation-common";
import type { SubmissionEnvelope, ValidatedSubmission } from "./event-validation-types";
import { HttpError } from "./http-error";
import { normalizeSourceHost } from "./normalization";
import type { SolverRecoveryEventInput } from "./schemas";

export function validateRecoverySubmission(
  payload: SubmissionEnvelope,
  event: SolverRecoveryEventInput,
): ValidatedSubmission {
  if (event.recoveryVersion === 2) {
    if (event.policyVersion !== "ladder_v2" || !event.appRevision || !event.solverVersions) {
      throw new HttpError(400, "invalid_recovery_v2_identity");
    }
  }
  const forecastId = recoveryForecastId(event.forecastId);
  const forecastProfileId = recoveryForecastProfileId(event.forecastProfileId);
  return {
    eventId: payload.eventId,
    sourceHost: normalizeSourceHost(payload.sourceHost),
    deliveryHealth: payload.deliveryHealth ?? null,
    event: {
      ...event,
      appRevision: event.appRevision ?? LEGACY_RECOVERY_REVISION,
      forecastId,
      forecastProfileId,
      solverVersions: event.solverVersions ?? LEGACY_RECOVERY_SOLVER_VERSIONS,
      start: validateState(event.start, false),
    },
  };
}

function recoveryForecastProfileId(value: unknown) {
  if (isSupplyForecastProfileId(value)) return value;
  if (value === undefined || value === null) return LEGACY_SUPPLY_FORECAST_PROFILE_ID;
  throw new HttpError(400, "invalid_supply_forecast_profile");
}

function recoveryForecastId(value: unknown) {
  if (isSupplyForecastId(value)) return value;
  if (value === undefined || value === null) return LEGACY_SUPPLY_FORECAST_ID;
  throw new HttpError(400, "invalid_supply_forecast");
}
