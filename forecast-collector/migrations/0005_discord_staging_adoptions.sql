PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS discord_staging_adoptions (
  approval_id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE CHECK (length(request_key) = 64),
  forecast_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  source_pull_request_number INTEGER NOT NULL CHECK (source_pull_request_number > 0),
  source_pull_request_url TEXT NOT NULL,
  source_head_sha TEXT NOT NULL CHECK (length(source_head_sha) = 40),
  registry_sha TEXT NOT NULL CHECK (length(registry_sha) = 40),
  research_run_id INTEGER NOT NULL CHECK (research_run_id > 0),
  research_run_url TEXT NOT NULL,
  research_artifact_name TEXT NOT NULL,
  research_artifact_digest TEXT NOT NULL CHECK (length(research_artifact_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'adoption_pr_created', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  approver_user_id TEXT,
  interaction_id TEXT UNIQUE,
  adoption_pull_request_number INTEGER,
  adoption_pull_request_url TEXT,
  staging_url TEXT,
  processed_at TEXT,
  CHECK (
    (state = 'pending' AND approved_at IS NULL AND approver_user_id IS NULL
      AND interaction_id IS NULL AND adoption_pull_request_number IS NULL
      AND adoption_pull_request_url IS NULL AND staging_url IS NULL AND processed_at IS NULL)
    OR
    (state = 'expired' AND approved_at IS NULL AND approver_user_id IS NULL
      AND interaction_id IS NULL AND adoption_pull_request_number IS NULL
      AND adoption_pull_request_url IS NULL AND staging_url IS NULL AND processed_at IS NULL)
    OR
    (state = 'approved' AND approved_at IS NOT NULL AND approver_user_id IS NOT NULL
      AND interaction_id IS NOT NULL AND adoption_pull_request_number IS NULL
      AND adoption_pull_request_url IS NULL AND staging_url IS NULL AND processed_at IS NULL)
    OR
    (state = 'adoption_pr_created' AND approved_at IS NOT NULL AND approver_user_id IS NOT NULL
      AND interaction_id IS NOT NULL AND adoption_pull_request_number IS NOT NULL
      AND adoption_pull_request_url IS NOT NULL AND staging_url IS NOT NULL
      AND processed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS discord_staging_adoptions_state_expires_idx
  ON discord_staging_adoptions(state, expires_at);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (5, CURRENT_TIMESTAMP);
