PRAGMA foreign_keys = ON;

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

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (4, CURRENT_TIMESTAMP);
