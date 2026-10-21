import { HttpError } from "./http";

/**
 * Fixed, privacy-safe failure vocabulary. This package stores personal data, so a record
 * carries only a fixed event and code: never exception text, identifiers, tokens, cookies,
 * queries or record contents. Classification stays with the caller; logging stays here.
 */
export type FailureCode =
  | HttpError["reason"]
  | "unexpected"
  | "invalid_summary"
  | "incomplete_write";

export type FailureEvent =
  | "personal_data_request_failed"
  | "personal_data_expiry_cleanup_failed"
  | "personal_data_inactivity_failed"
  | "personal_data_privacy_maintenance_failed"
  | "personal_data_publication_failed"
  | "personal_data_restore_failed"
  | "personal_data_deletion_resume_failed"
  | "personal_data_deletion_backoff_failed"
  | "personal_data_deletion_completion_failed"
  | "personal_data_privacy_completion_failed"
  | "personal_data_consent_maintenance_failed"
  | "personal_data_consent_backoff_failed"
  | "personal_data_publication_summary_invalid"
  | "personal_data_publication_token_release_failed"
  | "personal_data_restore_checkpoint_failed";

/** An `HttpError` reason is a closed enum, so it is safe to record; anything else is opaque. */
export function failureCode(error: unknown): FailureCode {
  return error instanceof HttpError ? error.reason : "unexpected";
}

export function logFailure(event: FailureEvent, code: FailureCode, lane?: number): void {
  console.error(JSON.stringify(lane === undefined ? { event, code } : { event, code, lane }));
}
