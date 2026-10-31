CREATE TABLE IF NOT EXISTS usage_guard_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  action TEXT NOT NULL CHECK (
    action IN (
      'normal',
      'warning',
      'disable_staging',
      'disable_forecast_production',
      'disable_statistics_writes',
      'hard_stop'
    )
  ),
  observed_at TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64),
  current_percent REAL NOT NULL,
  projected_percent REAL NOT NULL,
  governing_metric TEXT NOT NULL,
  normal_streak INTEGER NOT NULL DEFAULT 0,
  release_pending INTEGER NOT NULL DEFAULT 0 CHECK (release_pending IN (0, 1)),
  last_alert_action TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_guard_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_guard_snapshots_period_time
  ON usage_guard_snapshots(period_start, captured_at DESC);

CREATE TABLE IF NOT EXISTS usage_guard_runs (
  run_id TEXT PRIMARY KEY,
  scheduled_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failure')),
  evaluated_action TEXT,
  effective_action TEXT,
  error_code TEXT,
  alert_status TEXT,
  deployment_sha TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_guard_runs_started
  ON usage_guard_runs(started_at DESC);
