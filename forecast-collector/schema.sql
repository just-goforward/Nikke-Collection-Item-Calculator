PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS collector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
