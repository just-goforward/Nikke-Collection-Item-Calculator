-- Additive statistics observability schema. Apply to the named statistics D1 only.
CREATE TABLE IF NOT EXISTS solver_failure_aggregates_game_day (
  date_key TEXT NOT NULL,
  recovery_version INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  app_revision TEXT NOT NULL,
  ingest_revision TEXT NOT NULL,
  forecast_id TEXT NOT NULL,
  forecast_profile_id TEXT NOT NULL,
  rust_min_ef_solver_version TEXT NOT NULL,
  rust_phase2_solver_version TEXT NOT NULL,
  js_phase2_solver_version TEXT NOT NULL,
  requested_backend TEXT NOT NULL,
  min_ef_exit TEXT NOT NULL,
  phase2_exit TEXT NOT NULL,
  js_exit TEXT NOT NULL,
  terminal_backend TEXT NOT NULL,
  grade TEXT NOT NULL,
  level INTEGER NOT NULL,
  exp_bucket INTEGER NOT NULL,
  stock_bucket_blue TEXT NOT NULL,
  stock_bucket_purple TEXT NOT NULL,
  stock_bucket_yellow TEXT NOT NULL,
  browser TEXT NOT NULL,
  browser_major TEXT NOT NULL,
  os TEXT NOT NULL,
  os_major TEXT NOT NULL,
  device_type TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key, recovery_version, policy_version, app_revision, ingest_revision,
    forecast_id, forecast_profile_id, rust_min_ef_solver_version,
    rust_phase2_solver_version, js_phase2_solver_version, requested_backend,
    min_ef_exit, phase2_exit, js_exit, terminal_backend, grade, level, exp_bucket,
    stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow, browser,
    browser_major, os, os_major, device_type
  )
);
CREATE INDEX IF NOT EXISTS idx_solver_failure_last_seen
  ON solver_failure_aggregates_game_day (last_seen, terminal_backend);

CREATE TABLE IF NOT EXISTS stats_rejection_event_ids (
  event_id TEXT PRIMARY KEY,
  rejection_code TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stats_rejection_event_ids_created_at
  ON stats_rejection_event_ids (created_at);

CREATE TABLE IF NOT EXISTS stats_submission_rejection_aggregates_game_day (
  date_key TEXT NOT NULL,
  rejection_code TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  recovery_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  app_revision TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key, rejection_code, event_kind, recovery_version, policy_version, app_revision
  )
);
CREATE INDEX IF NOT EXISTS idx_stats_submission_rejection_last_seen
  ON stats_submission_rejection_aggregates_game_day (last_seen, rejection_code);

CREATE TABLE IF NOT EXISTS stats_delivery_health_aggregates_game_day (
  date_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  attempts_bucket TEXT NOT NULL,
  age_bucket TEXT NOT NULL,
  last_failure_class TEXT NOT NULL,
  app_revision TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key, outcome, event_kind, attempts_bucket, age_bucket,
    last_failure_class, app_revision
  )
);
CREATE INDEX IF NOT EXISTS idx_stats_delivery_health_last_seen
  ON stats_delivery_health_aggregates_game_day (last_seen, outcome);
