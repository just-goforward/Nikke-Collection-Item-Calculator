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

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (5, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (6, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (7, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (8, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (9, CURRENT_TIMESTAMP);

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

CREATE INDEX IF NOT EXISTS collector_invocations_latest_idx
  ON collector_invocations(
    scheduled_at DESC,
    status,
    next_retry_at,
    error_code,
    finished_at,
    started_at
  );

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
  review_generation INTEGER NOT NULL DEFAULT 0 CHECK (review_generation >= 0),
  error_code TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, item_id)
);

CREATE INDEX IF NOT EXISTS source_queue_status_published_idx
  ON source_queue(status, published_at, item_id);

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

CREATE TABLE IF NOT EXISTS canary_runs (
  canary_id TEXT PRIMARY KEY CHECK (
    substr(canary_id, 1, 3) = 'fc-' AND length(canary_id) = 35
      AND substr(canary_id, 4) NOT GLOB '*[^0-9a-f]*'
  ),
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  deployment_sha TEXT NOT NULL CHECK (length(deployment_sha) = 40),
  collector_cron TEXT NOT NULL CHECK (length(collector_cron) BETWEEN 1 AND 80),
  dispatcher_cron TEXT NOT NULL CHECK (length(dispatcher_cron) BETWEEN 1 AND 80),
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  quota_evidence_json TEXT NOT NULL CHECK (length(quota_evidence_json) BETWEEN 2 AND 65536),
  quota_evidence_hash TEXT NOT NULL CHECK (
    length(quota_evidence_hash) = 64
      AND quota_evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  CHECK (ends_at > started_at)
);

CREATE INDEX IF NOT EXISTS canary_runs_environment_sha_started_idx
  ON canary_runs(environment, deployment_sha, started_at DESC);

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
  discord_channel_id TEXT CHECK (discord_channel_id IS NULL OR length(discord_channel_id) BETWEEN 1 AND 24),
  discord_message_id TEXT UNIQUE CHECK (discord_message_id IS NULL OR length(discord_message_id) BETWEEN 1 AND 24),
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

CREATE INDEX IF NOT EXISTS dispatcher_invocations_environment_latest_idx
  ON dispatcher_invocations(
    environment,
    scheduled_at DESC,
    status,
    error_code,
    finished_at,
    started_at
  );

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
