PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS collector_invocations_latest_idx
  ON collector_invocations(
    scheduled_at DESC,
    status,
    next_retry_at,
    error_code,
    finished_at,
    started_at
  );

CREATE INDEX IF NOT EXISTS dispatcher_invocations_environment_latest_idx
  ON dispatcher_invocations(
    environment,
    scheduled_at DESC,
    status,
    error_code,
    finished_at,
    started_at
  );

CREATE TABLE IF NOT EXISTS canary_runs (
  canary_id TEXT PRIMARY KEY CHECK (
    substr(canary_id, 1, 3) = 'fc-' AND length(canary_id) = 35
      AND substr(canary_id, 4) NOT GLOB '*[^0-9a-f]*'
  ),
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  deployment_sha TEXT NOT NULL CHECK (length(deployment_sha) = 40),
  collector_cron TEXT NOT NULL CHECK (length(collector_cron) BETWEEN 1 AND 80),
  dispatcher_cron TEXT NOT NULL CHECK (length(dispatcher_cron) BETWEEN 1 AND 80),
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  quota_evidence_json TEXT NOT NULL CHECK (length(quota_evidence_json) BETWEEN 2 AND 65536),
  quota_evidence_hash TEXT NOT NULL CHECK (
    length(quota_evidence_hash) = 64
      AND quota_evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  CHECK (ends_at > started_at)
);

CREATE INDEX IF NOT EXISTS canary_runs_environment_sha_started_idx
  ON canary_runs(environment, deployment_sha, started_at DESC);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (9, CURRENT_TIMESTAMP);
