import { validateDiagnosticSubmission } from "./event-validation-diagnostic";
import { validateKitResultSubmission } from "./event-validation-kit";
import { validateRecoverySubmission } from "./event-validation-recovery";
import type { ValidatedSubmission } from "./event-validation-types";
import { normalizeSourceHost } from "./normalization";
import type { EventSubmission } from "./schemas";

export function validatePayload(payload: EventSubmission): ValidatedSubmission {
  const submission = {
    eventId: payload.eventId,
    sourceHost: payload.sourceHost,
    deliveryHealth: payload.deliveryHealth,
  };
  if (payload.event.kind === "runtime_invariant") {
    return {
      eventId: payload.eventId,
      sourceHost: normalizeSourceHost(payload.sourceHost),
      deliveryHealth: payload.deliveryHealth ?? null,
      event: payload.event,
    };
  }
  if (payload.event.kind === "solver_diagnostic") {
    return validateDiagnosticSubmission(submission, payload.event);
  }
  if (payload.event.kind === "solver_recovery") {
    return validateRecoverySubmission(submission, payload.event);
  }
  return validateKitResultSubmission(submission, payload.event);
}
