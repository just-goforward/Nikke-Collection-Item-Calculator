PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dispatcher_invocations (
  invocation_id TEXT PRIMARY KEY,
  deployment_sha TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  scheduled_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failure')),
  actionable_count INTEGER NOT NULL DEFAULT 0 CHECK (actionable_count >= 0),
  dispatch_id TEXT,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS dispatcher_invocations_deployment_scheduled_idx
  ON dispatcher_invocations(deployment_sha, scheduled_at DESC);

CREATE TABLE IF NOT EXISTS workflow_dispatches (
  dispatch_id TEXT PRIMARY KEY CHECK (dispatch_id GLOB 'fd-[0-9a-f]*' AND length(dispatch_id) = 35),
  slot_key TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  dispatch_mode TEXT NOT NULL CHECK (dispatch_mode IN ('work', 'smoke')),
  work_fingerprint TEXT NOT NULL CHECK (length(work_fingerprint) = 64),
  pending_count INTEGER NOT NULL CHECK (pending_count >= 0),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'reserved', 'accepted', 'running', 'succeeded', 'failed', 'cancelled', 'stale')
  ),
  dispatcher_deployment_sha TEXT,
  reserved_by_invocation TEXT,
  created_at TEXT NOT NULL,
  lease_until TEXT,
  requested_at TEXT,
  accepted_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  next_attempt_at TEXT,
  github_http_status INTEGER,
  github_run_id INTEGER CHECK (github_run_id IS NULL OR github_run_id > 0),
  github_run_attempt INTEGER CHECK (github_run_attempt IS NULL OR github_run_attempt > 0),
  github_run_url TEXT,
  error_code TEXT,
  discord_message_id TEXT CHECK (
    discord_message_id IS NULL OR length(discord_message_id) BETWEEN 1 AND 24
  ),
  discord_sent_at TEXT
);

CREATE INDEX IF NOT EXISTS workflow_dispatches_work_idx
  ON workflow_dispatches(environment, work_fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_dispatches_state_retry_idx
  ON workflow_dispatches(environment, state, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS forecast_ops_alerts (
  alert_key TEXT PRIMARY KEY CHECK (length(alert_key) BETWEEN 1 AND 160),
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  component TEXT NOT NULL CHECK (length(component) BETWEEN 1 AND 48),
  error_code TEXT NOT NULL CHECK (length(error_code) BETWEEN 1 AND 80),
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
  context_json TEXT NOT NULL DEFAULT '{}',
  notify_after_count INTEGER NOT NULL DEFAULT 1 CHECK (notify_after_count > 0),
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_sent_at TEXT,
  last_sent_occurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (last_sent_occurrence_count >= 0),
  next_send_at TEXT,
  resolved_at TEXT,
  recovery_sent_at TEXT,
  discord_message_id TEXT CHECK (
    discord_message_id IS NULL OR length(discord_message_id) BETWEEN 1 AND 24
  ),
  last_send_error TEXT
);

CREATE INDEX IF NOT EXISTS forecast_ops_alerts_due_idx
  ON forecast_ops_alerts(environment, state, next_send_at, last_seen_at);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (7, CURRENT_TIMESTAMP);
