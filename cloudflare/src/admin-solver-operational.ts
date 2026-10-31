import type { WorkerEnv } from "./env";

type OperationalPage = { limit: number; offset: number };

type OperationalFailureRow = {
  recovery_version?: number | string | null;
  policy_version?: string | null;
  app_revision?: string | null;
  ingest_revision?: string | null;
  forecast_id?: string | null;
  forecast_profile_id?: string | null;
  rust_min_ef_solver_version?: string | null;
  rust_phase2_solver_version?: string | null;
  js_phase2_solver_version?: string | null;
  requested_backend?: string | null;
  min_ef_exit?: string | null;
  phase2_exit?: string | null;
  js_exit?: string | null;
  terminal_backend?: string | null;
  grade?: string | null;
  level?: number | string | null;
  exp_bucket?: number | string | null;
  stock_bucket_blue?: string | null;
  stock_bucket_purple?: string | null;
  stock_bucket_yellow?: string | null;
  browser?: string | null;
  browser_major?: string | null;
  os?: string | null;
  os_major?: string | null;
  device_type?: string | null;
  events?: number | string | null;
  first_seen?: number | string | null;
  last_seen?: number | string | null;
};

type SubmissionRejectionRow = {
  rejection_code?: string | null;
  event_kind?: string | null;
  recovery_version?: string | null;
  policy_version?: string | null;
  app_revision?: string | null;
  events?: number | string | null;
  first_seen?: number | string | null;
  last_seen?: number | string | null;
};

type DeliveryHealthRow = {
  outcome?: string | null;
  event_kind?: string | null;
  attempts_bucket?: string | null;
  age_bucket?: string | null;
  last_failure_class?: string | null;
  app_revision?: string | null;
  events?: number | string | null;
  first_seen?: number | string | null;
  last_seen?: number | string | null;
};

export function operationalFailuresStatement(env: WorkerEnv, since: string, page: OperationalPage) {
  return env.DB.prepare(
    `SELECT recovery_version, policy_version, app_revision, ingest_revision,
            forecast_id, forecast_profile_id, rust_min_ef_solver_version,
            rust_phase2_solver_version, js_phase2_solver_version, requested_backend,
            min_ef_exit, phase2_exit, js_exit, terminal_backend, grade, level,
            exp_bucket, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
            browser, browser_major, os, os_major, device_type, events, first_seen, last_seen
     FROM solver_failure_aggregates_game_day
     WHERE date_key >= ?
     ORDER BY last_seen DESC, events DESC
     LIMIT ? OFFSET ?`,
  ).bind(since, page.limit + 1, page.offset);
}

export function mapOperationalFailures(result: D1Result<unknown>) {
  return (result.results ?? []).map((raw) => {
    const row = raw as OperationalFailureRow;
    return {
      recoveryVersion: numberOrZero(row.recovery_version),
      policyVersion: stringOr(row.policy_version, "unknown"),
      appRevision: stringOr(row.app_revision, "legacy-unversioned"),
      ingestRevision: stringOr(row.ingest_revision, "unknown"),
      forecastId: stringOr(row.forecast_id, "legacy-unversioned"),
      forecastProfileId: stringOr(row.forecast_profile_id, "legacy-unversioned-profile"),
      solverVersions: {
        rustMinEf: stringOr(row.rust_min_ef_solver_version, "legacy-unversioned"),
        rustPhase2: stringOr(row.rust_phase2_solver_version, "legacy-unversioned"),
        jsPhase2: stringOr(row.js_phase2_solver_version, "legacy-unversioned"),
      },
      requestedBackend: stringOr(row.requested_backend, "unknown"),
      exits: {
        minEf: stringOr(row.min_ef_exit, "unknown"),
        phase2: stringOr(row.phase2_exit, "unknown"),
        js: stringOr(row.js_exit, "unknown"),
      },
      terminalBackend: stringOr(row.terminal_backend, "none"),
      stateBucket: {
        grade: stringOr(row.grade, "unknown"),
        level: numberOrZero(row.level),
        exp: numberOrZero(row.exp_bucket),
      },
      stockBuckets: {
        blue: stringOr(row.stock_bucket_blue, "unknown"),
        purple: stringOr(row.stock_bucket_purple, "unknown"),
        yellow: stringOr(row.stock_bucket_yellow, "unknown"),
      },
      client: {
        browser: stringOr(row.browser, "Unknown"),
        browserMajor: stringOr(row.browser_major, "unknown"),
        os: stringOr(row.os, "Unknown"),
        osMajor: stringOr(row.os_major, "unknown"),
        deviceType: stringOr(row.device_type, "unknown"),
      },
      events: numberOrZero(row.events),
      firstSeen: numberOrZero(row.first_seen),
      lastSeen: numberOrZero(row.last_seen),
    };
  });
}

export function submissionRejectionsStatement(
  env: WorkerEnv,
  since: string,
  page: OperationalPage,
) {
  return env.DB.prepare(
    `SELECT rejection_code, event_kind, recovery_version, policy_version,
            app_revision, events, first_seen, last_seen
     FROM stats_submission_rejection_aggregates_game_day
     WHERE date_key >= ?
     ORDER BY last_seen DESC, events DESC
     LIMIT ? OFFSET ?`,
  ).bind(since, page.limit + 1, page.offset);
}

export function mapSubmissionRejections(result: D1Result<unknown>) {
  return (result.results ?? []).map((raw) => {
    const row = raw as SubmissionRejectionRow;
    return {
      rejectionCode: stringOr(row.rejection_code, "unknown"),
      eventKind: stringOr(row.event_kind, "unknown"),
      recoveryVersion: stringOr(row.recovery_version, "unknown"),
      policyVersion: stringOr(row.policy_version, "unknown"),
      appRevision: stringOr(row.app_revision, "unknown"),
      events: numberOrZero(row.events),
      firstSeen: numberOrZero(row.first_seen),
      lastSeen: numberOrZero(row.last_seen),
    };
  });
}

export function deliveryHealthStatement(env: WorkerEnv, since: string, page: OperationalPage) {
  return env.DB.prepare(
    `SELECT outcome, event_kind, attempts_bucket, age_bucket,
            last_failure_class, app_revision, events, first_seen, last_seen
     FROM stats_delivery_health_aggregates_game_day
     WHERE date_key >= ?
     ORDER BY last_seen DESC, events DESC
     LIMIT ? OFFSET ?`,
  ).bind(since, page.limit + 1, page.offset);
}

export function mapDeliveryHealth(result: D1Result<unknown>) {
  return (result.results ?? []).map((raw) => {
    const row = raw as DeliveryHealthRow;
    return {
      outcome: stringOr(row.outcome, "unknown"),
      eventKind: stringOr(row.event_kind, "unknown"),
      attemptsBucket: stringOr(row.attempts_bucket, "unknown"),
      ageBucket: stringOr(row.age_bucket, "unknown"),
      lastFailureClass: stringOr(row.last_failure_class, "unknown"),
      appRevision: stringOr(row.app_revision, "unknown"),
      events: numberOrZero(row.events),
      firstSeen: numberOrZero(row.first_seen),
      lastSeen: numberOrZero(row.last_seen),
    };
  });
}

function stringOr(value: string | null | undefined, fallback: string) {
  return value ? String(value) : fallback;
}

function numberOrZero(value: number | string | null | undefined) {
  return Number(value ?? 0);
}
