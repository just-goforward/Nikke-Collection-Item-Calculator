PRAGMA foreign_keys = ON;

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

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (3, CURRENT_TIMESTAMP);
