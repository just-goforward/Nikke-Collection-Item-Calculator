/** M0 wire contracts. Integers in timestamps are Unix milliseconds; no email identity. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface WorkspaceDocument {
  schemaVersion: 1;
  /** Calculator-owned representation; guests use the identical local representation. */
  items: Json[];
  lifetimeStages: StageSummary[];
}

export interface StageSummary {
  itemId: string;
  stage: string;
  lifetimeAttempts: number;
  lifetimeIncome: number;
  /** Imported/pre-signup income is retained personally, never counted publicly. */
  preSignupIncome: number;
  manualEntry: boolean;
  verified: boolean;
}

export interface Archive {
  archiveId: string;
  summary: StageSummary;
  startedAt: number;
  completedAt: number;
}

export type WorkspaceAction = { kind: "save" } | { kind: "archive"; archive: Archive };

export interface WorkspacePut {
  opId: string;
  baseRevision: number;
  document: WorkspaceDocument;
  action: WorkspaceAction;
}

export interface WorkspaceGet {
  /** Session-derived identity; clients must verify before displaying personal data. */
  userId: string;
  revision: number;
  lastOpId: string | null;
  document: WorkspaceDocument;
  quota: { bytes: number; limitBytes: number; newArchivingBlocked: boolean };
}

export type WorkspacePutResult =
  | { status: "saved"; revision: number; replayed: boolean }
  | { status: "revision_conflict"; revision: number }
  | { status: "op_id_conflict" }
  | { status: "archive_id_conflict" }
  | { status: "archive_quota_reached"; revision: number };

export interface ConsentGet {
  /** Null means show the one-time first-login question; never means opt-in. */
  participation: boolean | null;
  decisionVersion: number;
}
export interface ConsentPut {
  participation: boolean;
  baseDecisionVersion: number;
  opId: string;
}
export interface PrivacyAccepted {
  operationId: string;
  status: "pending" | "complete";
  /** Public releases are inaccessible before this acknowledgement. */
  fenceGeneration: number;
}
export interface DeleteAccountRequest {
  opId: string;
}
export interface RevokeAllRequest {
  opId: string;
}
export interface RevokeAllResult {
  revoked: true;
}

export interface PersonalExport {
  schemaVersion: 1;
  account: { userId: string; createdAt: number; lastActiveAt: number };
  exportedAt: number;
  workspace: WorkspaceGet;
  stages: StageSummary[];
  pendingArchives: Archive[];
  consent: ConsentGet;
  selfPercentiles: SelfPercentile[];
}

export interface PublicCell {
  stage: string;
  cohort: string;
  /** Binned disclosure only: no exact minima/maxima or user identifiers. */
  bands: { lower: number; upper: number; count: number }[];
  suppressed: boolean;
}
export interface PublicStatistics {
  releaseId: string;
  weekStart: string;
  fenceGeneration: number;
  cells: PublicCell[];
  policy?: {
    k: number;
    metric: "post_signup_income";
    binWidth: number;
    clampMax: number;
    countQuantum: number;
  };
}
/** Callback redirect vocabulary only; never provider errors, authorization codes or state. */
export type AccountCallbackError =
  | "account_switch_requires_logout"
  | "google_issuer_unsupported"
  | "admission_full"
  | "rate_limited"
  | "login_flow_expired"
  | "service_unavailable"
  | "unknown";
export interface SelfPercentile {
  releaseId: string;
  stage: string;
  /** Frozen against this release; suppressed/withdrawn results have no rank. */
  percentileBand: { lower: number; upper: number } | null;
  manualEntry: boolean;
  verified: boolean;
}

export type ApiErrorCode =
  | "unauthenticated"
  | "beta_full"
  | "revision_conflict"
  | "op_id_conflict"
  | "archive_quota_reached"
  | "invalid_request"
  | "privacy_fenced"
  | "not_implemented"
  | "origin_rejected"
  | "auth_failed"
  | "rate_limited"
  | "request_too_large"
  | "service_unavailable"
  | "not_found"
  | "method_not_allowed"
  | "google_issuer_unsupported"
  | "account_switch_requires_logout"
  | "account_context_required"
  | "account_context_stale"
  | "consent_change_pending"
  | "archive_id_conflict";
export interface ApiError {
  error: ApiErrorCode;
}

/**
 * Contract map, not a claim these routes are enabled in M1.
 * Private GETs accept an optional exact quoted If-Account-Match precondition:
 * mismatch returns 409 account_context_stale with no personal data.
 * With or without the header, successful reads identify the session owner.
 */
export interface Api {
  "POST /auth/login/google": {
    request: Record<string, never>;
    response: { authorizationUrl: string };
  };
  "POST /auth/callback/google": { request: { parameters: string }; response: { redirect: "/" } };
  "GET /v1/account": {
    headers: { "If-Account-Match"?: string };
    response: {
      authenticated: true;
      account: { userId: string; generation: number };
      consent: ConsentGet;
    };
  };
  "POST /auth/logout": { response: { loggedOut: true } };
  "GET /v1/workspace": {
    headers: { "If-Account-Match"?: string };
    response: WorkspaceGet;
  };
  "PUT /v1/workspace": {
    headers: { "If-Account-Match": string };
    request: WorkspacePut;
    response: WorkspacePutResult;
  };
  "GET /v1/export": {
    headers: { "If-Account-Match"?: string };
    response: PersonalExport;
  };
  "GET /v1/consent": {
    headers: { "If-Account-Match"?: string };
    response: ConsentGet & { userId: string };
  };
  "PUT /v1/consent": {
    headers: { "If-Account-Match": string };
    request: ConsentPut;
    response: ConsentGet | PrivacyAccepted;
  };
  "DELETE /v1/account": {
    headers: { "If-Account-Match": string };
    request: DeleteAccountRequest;
    response: PrivacyAccepted;
  };
  "POST /v1/sessions/revoke-all": {
    headers: { "If-Account-Match": string };
    request: RevokeAllRequest;
    response: RevokeAllResult;
  };
  "GET /v1/statistics": { response: PublicStatistics };
  "GET /v1/self-percentile": {
    headers: { "If-Account-Match"?: string };
    response: { userId: string; results: SelfPercentile[] };
  };
}
