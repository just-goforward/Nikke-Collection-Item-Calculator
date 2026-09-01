PRAGMA foreign_keys = ON;

ALTER TABLE source_queue
  ADD COLUMN review_generation INTEGER NOT NULL DEFAULT 0 CHECK (review_generation >= 0);

CREATE TABLE IF NOT EXISTS source_manual_reviews (
  review_id TEXT PRIMARY KEY CHECK (
    substr(review_id, 1, 3) = 'mr-' AND length(review_id) = 35
      AND substr(review_id, 4) NOT GLOB '*[^0-9a-f]*'
  ),
  source TEXT NOT NULL CHECK (source IN ('naver-board-48', 'naver-board-56')),
  item_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'expired')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('requeue', 'ignore', 'manual_event')),
  actor TEXT,
  reason TEXT,
  request_id TEXT CHECK (
    request_id IS NULL OR (
      substr(request_id, 1, 4) = 'mrq-' AND length(request_id) = 36
        AND substr(request_id, 5) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  request_payload_hash TEXT CHECK (
    request_payload_hash IS NULL OR length(request_payload_hash) = 64
  ),
  event_payload_hash TEXT CHECK (event_payload_hash IS NULL OR length(event_payload_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (source, item_id, generation),
  UNIQUE (request_id),
  FOREIGN KEY (source, item_id) REFERENCES source_queue(source, item_id),
  CHECK (
    (state = 'pending' AND decision IS NULL AND actor IS NULL AND reason IS NULL
      AND request_id IS NULL AND request_payload_hash IS NULL AND resolved_at IS NULL)
    OR
    (state = 'resolved' AND decision IS NOT NULL AND actor IS NOT NULL AND reason IS NOT NULL
      AND request_id IS NOT NULL AND request_payload_hash IS NOT NULL AND resolved_at IS NOT NULL)
    OR
    (state = 'expired' AND decision IS NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS source_manual_reviews_state_created_idx
  ON source_manual_reviews(state, created_at, review_id);

CREATE TABLE IF NOT EXISTS discord_interaction_audit (
  interaction_id TEXT PRIMARY KEY CHECK (
    length(interaction_id) BETWEEN 1 AND 24 AND interaction_id NOT GLOB '*[^0-9]*'
  ),
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  custom_id_hash TEXT NOT NULL CHECK (length(custom_id_hash) = 64),
  received_at TEXT NOT NULL,
  initial_response_at TEXT,
  completed_at TEXT,
  initial_response_ms INTEGER CHECK (initial_response_ms IS NULL OR initial_response_ms >= 0),
  replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  result TEXT CHECK (result IS NULL OR length(result) BETWEEN 1 AND 80),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS discord_interaction_audit_received_idx
  ON discord_interaction_audit(environment, received_at DESC);

CREATE TABLE IF NOT EXISTS canary_deployments (
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  deployment_sha TEXT NOT NULL CHECK (length(deployment_sha) = 40),
  collector_cron TEXT NOT NULL CHECK (length(collector_cron) BETWEEN 1 AND 80),
  dispatcher_cron TEXT NOT NULL CHECK (length(dispatcher_cron) BETWEEN 1 AND 80),
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (environment, deployment_sha),
  CHECK (ends_at > started_at)
);

INSERT OR IGNORE INTO source_manual_reviews (
  review_id, source, item_id, generation, state, created_at, expires_at
)
SELECT
  'mr-' || lower(hex(randomblob(16))), source, item_id, review_generation,
  'pending', updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+14 days')
FROM source_queue
WHERE status = 'manual_review';

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (8, CURRENT_TIMESTAMP);
