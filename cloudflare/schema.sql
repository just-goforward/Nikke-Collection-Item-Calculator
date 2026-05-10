CREATE TABLE IF NOT EXISTS event_ids (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_aggregates (
  date_key TEXT NOT NULL,
  grade TEXT NOT NULL,
  level INTEGER NOT NULL,
  exp_bucket INTEGER NOT NULL,
  kit TEXT NOT NULL,
  recommended_uses INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  success_attempt INTEGER NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  great_successes INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key,
    grade,
    level,
    exp_bucket,
    kit,
    recommended_uses,
    outcome,
    success_attempt
  )
);

CREATE INDEX IF NOT EXISTS idx_event_aggregates_date ON event_aggregates (date_key);
CREATE INDEX IF NOT EXISTS idx_event_aggregates_kit ON event_aggregates (kit);

CREATE TABLE IF NOT EXISTS referrer_aggregates (
  date_key TEXT NOT NULL,
  source_host TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key,
    source_host
  )
);

CREATE INDEX IF NOT EXISTS idx_referrer_aggregates_date ON referrer_aggregates (date_key);
