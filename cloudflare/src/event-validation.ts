import { validateDiagnosticSubmission } from "./event-validation-diagnostic";
import { validateKitResultSubmission } from "./event-validation-kit";
import type { ValidatedSubmission } from "./event-validation-types";
import type { EventSubmission } from "./schemas";

export function validatePayload(payload: EventSubmission): ValidatedSubmission {
  const submission = { eventId: payload.eventId, sourceHost: payload.sourceHost };
  return payload.event.kind === "solver_diagnostic"
    ? validateDiagnosticSubmission(submission, payload.event)
    : validateKitResultSubmission(submission, payload.event);
}
