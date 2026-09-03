CREATE TABLE IF NOT EXISTS observer_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  baseline_initialized INTEGER NOT NULL DEFAULT 0 CHECK (baseline_initialized IN (0, 1)),
  baseline_at TEXT,
  last_poll_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO observer_state (singleton_id, baseline_initialized, updated_at)
VALUES (1, 0, '1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS observer_runs (
  run_id TEXT PRIMARY KEY,
  scheduled_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failure')),
  rows_observed INTEGER NOT NULL DEFAULT 0,
  deltas_observed INTEGER NOT NULL DEFAULT 0,
  alerts_attempted INTEGER NOT NULL DEFAULT 0,
  duplicate_attempts INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_attempts >= 0),
  error_code TEXT,
  deployment_sha TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observer_runs_started
  ON observer_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS observer_source_cursors (
  source_kind TEXT NOT NULL,
  row_hash TEXT NOT NULL CHECK (length(row_hash) = 64),
  last_events INTEGER NOT NULL CHECK (last_events >= 0),
  source_last_seen INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_kind, row_hash)
);

CREATE TABLE IF NOT EXISTS observer_alerts (
  fingerprint TEXT PRIMARY KEY CHECK (length(fingerprint) = 64),
  source_kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  error_code TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  context_json TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  window_count INTEGER NOT NULL CHECK (window_count >= 0),
  total_count INTEGER NOT NULL CHECK (total_count >= 0),
  last_sent_at TEXT,
  last_sent_severity TEXT CHECK (last_sent_severity IS NULL OR last_sent_severity IN ('warning', 'critical')),
  discord_message_id TEXT,
  next_send_at TEXT,
  send_status TEXT NOT NULL DEFAULT 'pending' CHECK (send_status IN ('pending', 'sent', 'failed')),
  last_send_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observer_alerts_due
  ON observer_alerts (state, next_send_at, severity);

CREATE TABLE IF NOT EXISTS observer_canaries (
  canary_id TEXT PRIMARY KEY,
  deployment_sha TEXT NOT NULL CHECK (length(deployment_sha) = 40),
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
  checked_at TEXT,
  report_json TEXT
);
