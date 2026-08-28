PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (1, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (2, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (3, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (4, CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS collector_invocations (
  invocation_id TEXT PRIMARY KEY,
  deployment_sha TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failure', 'circuit_open')),
  poll_mode TEXT NOT NULL CHECK (poll_mode IN ('both', 'alternating')),
  queued_count INTEGER NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
  error_code TEXT,
  next_retry_at TEXT
);

CREATE INDEX IF NOT EXISTS collector_invocations_deployment_scheduled_idx
  ON collector_invocations(deployment_sha, scheduled_at DESC);

CREATE TABLE IF NOT EXISTS source_poll_state (
  source TEXT PRIMARY KEY CHECK (source IN ('naver-board-48', 'naver-board-56')),
  committed_item_id TEXT,
  committed_published_at TEXT,
  scan_head_item_id TEXT,
  scan_head_published_at TEXT,
  next_offset INTEGER NOT NULL DEFAULT 0 CHECK (next_offset >= 0),
  updated_at TEXT NOT NULL,
  CHECK ((committed_item_id IS NULL) = (committed_published_at IS NULL)),
  CHECK ((scan_head_item_id IS NULL) = (scan_head_published_at IS NULL))
);

CREATE TABLE IF NOT EXISTS source_queue (
  source TEXT NOT NULL CHECK (source IN ('naver-board-48', 'naver-board-56')),
  item_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  official INTEGER NOT NULL CHECK (official IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'ignored', 'manual_review')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, item_id)
);

CREATE INDEX IF NOT EXISTS source_queue_status_published_idx
  ON source_queue(status, published_at, item_id);

CREATE TABLE IF NOT EXISTS collector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_sha TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('naver', 'x', 'collector')),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failure', 'circuit_open')),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  error_code TEXT,
  next_retry_at TEXT,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0)
);

CREATE INDEX IF NOT EXISTS collector_runs_source_started_idx
  ON collector_runs(source, started_at DESC);

CREATE TABLE IF NOT EXISTS source_watermarks (
  source TEXT PRIMARY KEY CHECK (source IN ('naver-board-48', 'naver-board-56', 'x-nikke-kr')),
  item_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_items (
  source TEXT NOT NULL CHECK (source IN ('naver-board-48', 'naver-board-56', 'x-nikke-kr')),
  item_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  published_at TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  structured INTEGER NOT NULL CHECK (structured IN (0, 1)),
  official INTEGER NOT NULL CHECK (official IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source, item_id)
);

CREATE TABLE IF NOT EXISTS schedule_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('solo', 'cooperation', 'collaboration', 'schedule_change', 'reward')
  ),
  source TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  schedule_status TEXT NOT NULL CHECK (schedule_status IN ('confirmed', 'estimated')),
  manual_review INTEGER NOT NULL CHECK (manual_review IN (0, 1)),
  reason TEXT,
  observed_at TEXT NOT NULL,
  FOREIGN KEY (source, source_item_id) REFERENCES source_items(source, item_id)
);

CREATE INDEX IF NOT EXISTS schedule_events_type_start_idx
  ON schedule_events(event_type, starts_at DESC);

CREATE TABLE IF NOT EXISTS forecast_candidates (
  candidate_id TEXT PRIMARY KEY,
  forecast_id TEXT NOT NULL,
  schedule_event_id TEXT NOT NULL,
  game_day TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_status TEXT NOT NULL CHECK (source_status IN ('crosschecked', 'x_unavailable', 'conflict')),
  state TEXT NOT NULL CHECK (
    state IN ('observed', 'parsed', 'crosschecked', 'x_unavailable', 'conflict', 'proposed', 'approved', 'rejected', 'superseded')
  ),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL UNIQUE CHECK (length(payload_hash) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (schedule_event_id) REFERENCES schedule_events(event_id)
);

CREATE INDEX IF NOT EXISTS forecast_candidates_state_created_idx
  ON forecast_candidates(state, created_at);

CREATE TABLE IF NOT EXISTS candidate_sources (
  candidate_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  PRIMARY KEY (candidate_id, source, source_item_id),
  FOREIGN KEY (candidate_id) REFERENCES forecast_candidates(candidate_id),
  FOREIGN KEY (source, source_item_id) REFERENCES source_items(source, item_id)
);

CREATE TABLE IF NOT EXISTS discord_approval_tests (
  approval_id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE CHECK (length(request_key) = 64),
  candidate_id TEXT NOT NULL,
  forecast_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
  pull_request_url TEXT NOT NULL,
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  state TEXT NOT NULL CHECK (state IN ('pending', 'test_approved', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  approver_user_id TEXT,
  interaction_id TEXT UNIQUE,
  CHECK (
    (state = 'test_approved' AND approved_at IS NOT NULL
      AND approver_user_id IS NOT NULL AND interaction_id IS NOT NULL)
    OR
    (state IN ('pending', 'expired') AND approved_at IS NULL
      AND approver_user_id IS NULL AND interaction_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS discord_approval_tests_state_expires_idx
  ON discord_approval_tests(state, expires_at);
