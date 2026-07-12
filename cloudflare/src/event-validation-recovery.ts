import { validateState } from "./event-validation-common";
import type { SubmissionEnvelope, ValidatedSubmission } from "./event-validation-types";
import { normalizeSourceHost } from "./normalization";
import type { SolverRecoveryEventInput } from "./schemas";

export function validateRecoverySubmission(
  payload: SubmissionEnvelope,
  event: SolverRecoveryEventInput,
): ValidatedSubmission {
  return {
    eventId: payload.eventId,
    sourceHost: normalizeSourceHost(payload.sourceHost),
    event: {
      ...event,
      start: validateState(event.start, false),
    },
  };
}
