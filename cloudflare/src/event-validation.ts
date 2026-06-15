import { asRecord, field } from "./event-validation-common";
import { validateDiagnosticSubmission } from "./event-validation-diagnostic";
import { validateKitResultSubmission } from "./event-validation-kit";
import type { ValidatedSubmission } from "./event-validation-types";
import { HttpError } from "./http-error";

export function validatePayload(payload: unknown): ValidatedSubmission {
  const data = asRecord(payload, "invalid_payload");
  if (field(data, "version") !== 1) throw new HttpError(400, "invalid_version");
  const eventId = field(data, "eventId");
  if (typeof eventId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(eventId)) {
    throw new HttpError(400, "invalid_event_id");
  }

  const event = asRecord(field(data, "event"), "invalid_event_kind");
  const submission = { eventId, sourceHost: field(data, "sourceHost") };
  if (field(event, "kind") === "solver_diagnostic") {
    return validateDiagnosticSubmission(submission, event);
  }
  if (field(event, "kind") !== "kit_result") throw new HttpError(400, "invalid_event_kind");

  return validateKitResultSubmission(submission, event);
}
