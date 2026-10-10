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

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (10, CURRENT_TIMESTAMP);

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
  collector_version_id TEXT NOT NULL CHECK (length(collector_version_id) = 36),
  dispatcher_version_id TEXT NOT NULL CHECK (length(dispatcher_version_id) = 36),
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


CREATE TABLE IF NOT EXISTS source_processing_claims (
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  attempted_at TEXT,
  source_generation INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  result_token TEXT,
  next_retry_at TEXT,
  last_checked_at TEXT,
  PRIMARY KEY (source, item_id),
  FOREIGN KEY (source, item_id) REFERENCES source_queue(source, item_id)
);
CREATE INDEX IF NOT EXISTS source_processing_claims_retry_idx
  ON source_processing_claims(next_retry_at, lease_until);

CREATE TABLE IF NOT EXISTS source_collection_health (
  source TEXT PRIMARY KEY CHECK (source IN ('naver-board-48','naver-board-56')),
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  scan_complete INTEGER NOT NULL DEFAULT 0 CHECK (scan_complete IN (0,1)),
  schema_drift INTEGER NOT NULL DEFAULT 0 CHECK (schema_drift IN (0,1)),
  gap_detected INTEGER NOT NULL DEFAULT 0 CHECK (gap_detected IN (0,1)),
  gap_since_at TEXT,
  collection_failures INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);
CREATE TABLE IF NOT EXISTS forecast_refresh_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  checked_game_day TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT
);
CREATE TABLE IF NOT EXISTS forecast_candidate_semantics (
  semantic_hash TEXT NOT NULL CHECK(length(semantic_hash)=64),
  candidate_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES forecast_candidates(candidate_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS forecast_candidates_day_revision_cas_idx
  ON forecast_candidates(game_day, revision);
CREATE TABLE IF NOT EXISTS staging_adoption_processing (
  approval_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('pending','retry','failed_permanent','completed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_stage_outcomes (
  dispatch_id TEXT PRIMARY KEY,
  queue_outcome TEXT NOT NULL,
  candidate_created INTEGER NOT NULL CHECK(candidate_created IN (0,1)),
  proposal_created INTEGER NOT NULL CHECK(proposal_created IN (0,1)),
  work_expected INTEGER NOT NULL CHECK(work_expected IN (0,1)),
  observed_at TEXT NOT NULL,
  FOREIGN KEY(dispatch_id) REFERENCES workflow_dispatches(dispatch_id)
);

CREATE TABLE IF NOT EXISTS source_body_recheck_reservations (
  game_day TEXT NOT NULL,
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  reservation_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(game_day,source,item_id)
);

CREATE TABLE IF NOT EXISTS source_manual_resolution_evidence (
  review_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  created_at TEXT NOT NULL,
  FOREIGN KEY(review_id) REFERENCES source_manual_reviews(review_id)
);


CREATE TABLE IF NOT EXISTS source_notice_revisions (
  source TEXT NOT NULL, item_id TEXT NOT NULL, source_revision INTEGER NOT NULL CHECK(source_revision>0),
  body_hash TEXT NOT NULL CHECK(length(body_hash)=64), revision_hash TEXT NOT NULL CHECK(length(revision_hash)=64),
  semantic_hash TEXT NOT NULL CHECK(length(semantic_hash)=64), item_json TEXT NOT NULL CHECK(json_valid(item_json)),
  events_json TEXT NOT NULL CHECK(json_valid(events_json)), observed_at TEXT NOT NULL,
  PRIMARY KEY(source,item_id,source_revision)
);
CREATE TABLE IF NOT EXISTS source_manual_review_bindings (
  review_id TEXT PRIMARY KEY, source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  body_hash TEXT, revision_hash TEXT, semantic_hash TEXT, generation INTEGER NOT NULL,
  review_token TEXT NOT NULL CHECK(length(review_token)=64), metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  item_json TEXT CHECK(item_json IS NULL OR json_valid(item_json)), created_at TEXT NOT NULL,
  FOREIGN KEY(review_id) REFERENCES source_manual_reviews(review_id)
);
CREATE TABLE IF NOT EXISTS schedule_event_source_revisions (
  event_id TEXT PRIMARY KEY, source TEXT NOT NULL, item_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
  FOREIGN KEY(event_id) REFERENCES schedule_events(event_id),
  FOREIGN KEY(source,item_id,source_revision) REFERENCES source_notice_revisions(source,item_id,source_revision)
);

CREATE TRIGGER IF NOT EXISTS source_notice_revisions_update_immutable BEFORE UPDATE ON source_notice_revisions BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_notice_revisions_delete_immutable BEFORE DELETE ON source_notice_revisions BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_manual_review_bindings_update_immutable BEFORE UPDATE ON source_manual_review_bindings BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_manual_review_bindings_delete_immutable BEFORE DELETE ON source_manual_review_bindings BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_manual_resolution_evidence_update_immutable BEFORE UPDATE ON source_manual_resolution_evidence BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_manual_resolution_evidence_delete_immutable BEFORE DELETE ON source_manual_resolution_evidence BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;

CREATE TRIGGER IF NOT EXISTS source_notice_revisions_replace_immutable BEFORE INSERT ON source_notice_revisions WHEN EXISTS(SELECT 1 FROM source_notice_revisions WHERE source=NEW.source AND item_id=NEW.item_id AND source_revision=NEW.source_revision) BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_manual_review_bindings_replace_immutable BEFORE INSERT ON source_manual_review_bindings WHEN EXISTS(SELECT 1 FROM source_manual_review_bindings WHERE review_id=NEW.review_id) BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_manual_resolution_evidence_replace_immutable BEFORE INSERT ON source_manual_resolution_evidence WHEN EXISTS(SELECT 1 FROM source_manual_resolution_evidence WHERE review_id=NEW.review_id) BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;

INSERT INTO source_manual_review_bindings(review_id,source_revision,body_hash,revision_hash,semantic_hash,generation,review_token,metadata_json,item_json,created_at)
SELECT r.review_id,0,s.content_hash,NULL,NULL,r.generation,lower(hex(randomblob(32))),
  json_object('source',q.source,'itemId',q.item_id,'url',q.url,'title',q.title,'publishedAt',q.published_at,'official',q.official),NULL,CURRENT_TIMESTAMP
FROM source_manual_reviews r JOIN source_queue q ON q.source=r.source AND q.item_id=r.item_id AND q.review_generation=r.generation
LEFT JOIN source_items s ON s.source=q.source AND s.item_id=q.item_id
WHERE r.state='pending' AND q.status='manual_review' AND NOT EXISTS(SELECT 1 FROM source_manual_review_bindings WHERE review_id=r.review_id);




-- Preserve accepted legacy facts and recorded source metadata. No full body or
-- notice revision can be reconstructed from a pre-0011 excerpt.
CREATE TABLE IF NOT EXISTS source_legacy_event_baselines (
  event_id TEXT PRIMARY KEY,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  body_available INTEGER NOT NULL DEFAULT 0 CHECK(body_available=0),
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(event_id) REFERENCES schedule_events(event_id)
);
INSERT INTO source_legacy_event_baselines(event_id,source_json,event_json,recorded_at)
SELECT e.event_id,
  json_object('source',s.source,'itemId',s.item_id,'url',s.url,'title',s.title,'excerpt',s.excerpt,'publishedAt',s.published_at,'contentHash',s.content_hash,'official',json(CASE WHEN s.official=1 THEN 'true' ELSE 'false' END)),
  json_object('eventId',e.event_id,'eventType',e.event_type,'startsAt',e.starts_at,'endsAt',e.ends_at,'scheduleStatus',e.schedule_status,'reason',e.reason),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM schedule_events e JOIN source_items s ON s.source=e.source AND s.item_id=e.source_item_id
WHERE e.manual_review=0 AND NOT EXISTS(SELECT 1 FROM schedule_event_source_revisions er JOIN source_notice_revisions n
  ON n.source=er.source AND n.item_id=er.item_id AND n.source_revision=er.source_revision WHERE er.event_id=e.event_id)
  AND NOT EXISTS(SELECT 1 FROM source_legacy_event_baselines b WHERE b.event_id=e.event_id);
CREATE TRIGGER IF NOT EXISTS source_legacy_event_baselines_update_immutable BEFORE UPDATE ON source_legacy_event_baselines BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_legacy_event_baselines_delete_immutable BEFORE DELETE ON source_legacy_event_baselines BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_legacy_event_baselines_replace_immutable BEFORE INSERT ON source_legacy_event_baselines WHEN EXISTS(SELECT 1 FROM source_legacy_event_baselines WHERE event_id=NEW.event_id) BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;

INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(11,CURRENT_TIMESTAMP);

-- Selection consumes an attempt before any validator or external workflow work.
CREATE TABLE IF NOT EXISTS staging_adoption_attempt_leases (
  approval_id TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL CHECK(length(lease_token)=36),
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 8),
  state TEXT NOT NULL CHECK(state IN ('active','settled')),
  lease_until TEXT NOT NULL,
  outcome TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  FOREIGN KEY(approval_id) REFERENCES discord_staging_adoptions(approval_id)
);
CREATE INDEX IF NOT EXISTS staging_adoption_lease_expiry ON staging_adoption_attempt_leases(state,lease_until);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(12,CURRENT_TIMESTAMP);

-- Observation and circuit storage is create-only: retrying a partially applied
-- migration does not ALTER existing tables or rewrite accepted source evidence.
CREATE TABLE IF NOT EXISTS source_metadata_observations (
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  metadata_hash TEXT NOT NULL CHECK(length(metadata_hash)=64),
  review_generation INTEGER NOT NULL CHECK(review_generation>=0),
  invalid INTEGER NOT NULL CHECK(invalid IN (0,1)),
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(source,item_id),
  FOREIGN KEY(source,item_id) REFERENCES source_queue(source,item_id)
);

CREATE TABLE IF NOT EXISTS source_poll_scan_status (
  source TEXT PRIMARY KEY,
  scan_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(scan_uncertain IN (0,1)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(source) REFERENCES source_poll_state(source)
);

CREATE TABLE IF NOT EXISTS staging_adoption_infrastructure_circuit (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  state TEXT NOT NULL CHECK(state IN ('healthy','retry','blocked')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
  error_code TEXT,
  first_failed_at TEXT NOT NULL,
  next_probe_at TEXT,
  probe_token TEXT CHECK(probe_token IS NULL OR length(probe_token)=36),
  probe_lease_until TEXT,
  updated_at TEXT NOT NULL,
  CHECK((probe_token IS NULL)=(probe_lease_until IS NULL))
);

INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(13,CURRENT_TIMESTAMP);

-- Durable source-processor attempts and recovery proofs. Create-only upgrade.
-- accepted source evidence and per-item decisions are never rewritten here.
CREATE TABLE IF NOT EXISTS source_processor_state (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch>=1),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','retry','held','verifying','verified')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 3),
  next_retry_at TEXT,
  active_token TEXT CHECK(active_token IS NULL OR length(active_token)=36),
  lease_until TEXT,
  last_error_code TEXT,
  failed_scope TEXT CHECK(failed_scope IS NULL OR failed_scope IN ('pipeline','metadata','daily','claim','detail','refresh')),
  failed_source TEXT CHECK(failed_source IS NULL OR failed_source IN ('naver-board-48','naver-board-56')),
  failed_item_id TEXT,
  failed_generation INTEGER CHECK(failed_generation IS NULL OR failed_generation>=0),
  updated_at TEXT NOT NULL,
  CHECK((active_token IS NULL)=(lease_until IS NULL))
);
CREATE TABLE IF NOT EXISTS source_processor_runs (
  token TEXT PRIMARY KEY CHECK(length(token)=36),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  kind TEXT NOT NULL CHECK(kind IN ('normal','recovery')),
  implicit INTEGER NOT NULL DEFAULT 0 CHECK(implicit IN (0,1)),
  environment TEXT NOT NULL DEFAULT 'staging' CHECK(environment IN ('staging','production')),
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','failure','cancelled','expired','verified')),
  started_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  finished_at TEXT,
  scope TEXT NOT NULL DEFAULT 'pipeline' CHECK(scope IN ('pipeline','metadata','daily','claim','detail','refresh')),
  error_code TEXT,
  failed_source TEXT CHECK(failed_source IS NULL OR failed_source IN ('naver-board-48','naver-board-56')),
  failed_item_id TEXT,
  failed_generation INTEGER CHECK(failed_generation IS NULL OR failed_generation>=0),
  metadata_completed INTEGER NOT NULL DEFAULT 0 CHECK(metadata_completed IN (0,1)),
  daily_completed INTEGER NOT NULL DEFAULT 0 CHECK(daily_completed IN (0,1)),
  claim_completed INTEGER NOT NULL DEFAULT 0 CHECK(claim_completed IN (0,1)),
  validated_items INTEGER NOT NULL DEFAULT 0 CHECK(validated_items>=0),
  refresh_completed INTEGER NOT NULL DEFAULT 0 CHECK(refresh_completed IN (0,1)),
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  resumed_at TEXT,
  resume_reason TEXT CHECK(resume_reason IS NULL OR length(resume_reason) BETWEEN 1 AND 500),
  CHECK((resumed_at IS NULL)=(resume_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_source_processor_runs_epoch ON source_processor_runs(epoch,started_at);
CREATE TABLE IF NOT EXISTS source_processor_item_bindings (
  run_token TEXT NOT NULL REFERENCES source_processor_runs(token),
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_claim_token TEXT NOT NULL CHECK(length(item_claim_token)=36),
  source_generation INTEGER NOT NULL CHECK(source_generation>=0),
  settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),
  validated INTEGER NOT NULL DEFAULT 0 CHECK(validated IN (0,1)),
  PRIMARY KEY(run_token,source,item_id,source_generation),
  CHECK(validated<=settled),
  FOREIGN KEY(source,item_id) REFERENCES source_queue(source,item_id)
);
CREATE INDEX IF NOT EXISTS idx_source_processor_item_claim ON source_processor_item_bindings(item_claim_token,source,item_id);

INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(14,CURRENT_TIMESTAMP);

-- Create-only adoption recovery and approved-age clock storage.
-- Legacy nonhealthy state starts a pause only at this migration, as prior
-- continuous hold intervals cannot be inferred from lifetime counters.
CREATE TABLE IF NOT EXISTS staging_adoption_recovery_control (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch>=1),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','held','verified')),
  failure_generation INTEGER NOT NULL DEFAULT 0 CHECK(failure_generation>=0),
  error_code TEXT,
  failed_stage TEXT NOT NULL DEFAULT 'unknown' CHECK(failed_stage IN ('selection','generation','delivery','unknown')),
  recovery_token TEXT CHECK(recovery_token IS NULL OR length(recovery_token)=36),
  recovery_lease_until TEXT,
  next_recovery_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK((recovery_token IS NULL)=(recovery_lease_until IS NULL))
);
CREATE TABLE IF NOT EXISTS staging_adoption_hold_episodes (
  epoch INTEGER PRIMARY KEY CHECK(epoch>=1),
  held_at TEXT NOT NULL,
  resumed_at TEXT,
  initial_error_code TEXT,
  last_error_code TEXT,
  failed_stage TEXT NOT NULL CHECK(failed_stage IN ('selection','generation','delivery','unknown')),
  legacy_history_unknown INTEGER NOT NULL DEFAULT 0 CHECK(legacy_history_unknown IN (0,1)),
  probe_attempts_at_hold INTEGER NOT NULL DEFAULT 0 CHECK(probe_attempts_at_hold BETWEEN 0 AND 8),
  probe_attempts_at_resume INTEGER CHECK(probe_attempts_at_resume IS NULL OR probe_attempts_at_resume BETWEEN 0 AND 8),
  updated_at TEXT NOT NULL,
  CHECK(resumed_at IS NULL OR resumed_at>=held_at)
);
CREATE INDEX IF NOT EXISTS idx_adoption_hold_intervals ON staging_adoption_hold_episodes(resumed_at,held_at);
CREATE TABLE IF NOT EXISTS staging_adoption_recovery_runs (
  recovery_token TEXT PRIMARY KEY CHECK(length(recovery_token)=36),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  failure_generation INTEGER NOT NULL CHECK(failure_generation>=0),
  error_code TEXT NOT NULL,
  failed_stage TEXT NOT NULL CHECK(failed_stage IN ('selection','generation','delivery','unknown')),
  status TEXT NOT NULL CHECK(status IN ('active','verified','failed','expired','invalidated','resumed')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  started_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  verified_at TEXT,
  finished_at TEXT,
  evidence_json TEXT,
  resume_reason TEXT CHECK(resume_reason IS NULL OR length(resume_reason) BETWEEN 1 AND 500),
  approval_id TEXT,
  approval_binding_hash TEXT CHECK(approval_binding_hash IS NULL OR length(approval_binding_hash)=64),
  CHECK((approval_id IS NULL)=(approval_binding_hash IS NULL)),
  FOREIGN KEY(epoch) REFERENCES staging_adoption_hold_episodes(epoch)
);
CREATE INDEX IF NOT EXISTS idx_adoption_recovery_epoch ON staging_adoption_recovery_runs(epoch,started_at);
INSERT OR IGNORE INTO staging_adoption_recovery_control
  (singleton_id,epoch,state,failure_generation,error_code,failed_stage,updated_at)
  SELECT 1,1,'held',1,error_code,'unknown',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM staging_adoption_infrastructure_circuit WHERE state IN ('retry','blocked');
INSERT OR IGNORE INTO staging_adoption_hold_episodes
  (epoch,held_at,initial_error_code,last_error_code,failed_stage,legacy_history_unknown,probe_attempts_at_hold,updated_at)
  SELECT r.epoch,r.updated_at,r.error_code,r.error_code,'unknown',1,c.attempts,r.updated_at
  FROM staging_adoption_recovery_control r JOIN staging_adoption_infrastructure_circuit c ON c.singleton_id=r.singleton_id
  WHERE r.epoch=1 AND r.state='held' AND r.failure_generation=1 AND c.state IN ('retry','blocked');
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(15,CURRENT_TIMESTAMP);

-- Durable, per-environment GitHub dispatch budget and explicit recovery audit.
CREATE TABLE IF NOT EXISTS dispatcher_retry_state (
  environment TEXT PRIMARY KEY CHECK(environment IN ('staging','production')),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch>=1),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','held','verified')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 3),
  held_at TEXT,
  proof_dispatch_id TEXT,
  proof_run_id INTEGER CHECK(proof_run_id IS NULL OR proof_run_id>0),
  proof_run_attempt INTEGER CHECK(proof_run_attempt IS NULL OR proof_run_attempt>0),
  proof_run_url TEXT,
  proof_reason TEXT CHECK(proof_reason IS NULL OR length(proof_reason) BETWEEN 1 AND 500),
  proof_conclusion TEXT CHECK(proof_conclusion IS NULL OR proof_conclusion IN ('success','failure','cancelled')),
  proof_kind TEXT CHECK(proof_kind IS NULL OR proof_kind IN ('callback','trusted_runner')),
  verified_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dispatcher_retry_attempts (
  dispatch_id TEXT PRIMARY KEY REFERENCES workflow_dispatches(dispatch_id),
  environment TEXT NOT NULL REFERENCES dispatcher_retry_state(environment),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  outcome TEXT NOT NULL DEFAULT 'reserved' CHECK(outcome IN ('reserved','accepted','failure')),
  settled_at TEXT,
  CHECK(environment IN ('staging','production'))
);
CREATE INDEX IF NOT EXISTS idx_dispatcher_retry_attempt_epoch ON dispatcher_retry_attempts(environment,epoch,outcome);
CREATE TABLE IF NOT EXISTS dispatcher_retry_proofs (
  environment TEXT NOT NULL REFERENCES dispatcher_retry_state(environment),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  dispatch_id TEXT NOT NULL REFERENCES workflow_dispatches(dispatch_id),
  run_id INTEGER NOT NULL CHECK(run_id>0),
  run_attempt INTEGER NOT NULL CHECK(run_attempt>0),
  run_url TEXT NOT NULL,
  conclusion TEXT NOT NULL CHECK(conclusion IN ('success','failure','cancelled')),
  kind TEXT NOT NULL CHECK(kind IN ('callback','trusted_runner')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  operation_at TEXT NOT NULL,
  operation_actor TEXT NOT NULL CHECK(operation_actor='dispatcher_github_app'),
  operation_name TEXT NOT NULL CHECK(operation_name='workflow_dispatch'),
  operation_http_status INTEGER NOT NULL CHECK(operation_http_status IN (200,204)),
  observed_at TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  resumed_at TEXT,
  resume_reason TEXT CHECK(resume_reason IS NULL OR length(resume_reason) BETWEEN 1 AND 500),
  PRIMARY KEY(environment,epoch),
  CHECK(environment IN ('staging','production')),
  CHECK((resumed_at IS NULL)=(resume_reason IS NULL))
);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(16,CURRENT_TIMESTAMP);

-- Create-only incident and recovery evidence. No historical success is inferred.
CREATE TABLE IF NOT EXISTS source_processor_incidents (
  origin_run_token TEXT PRIMARY KEY REFERENCES source_processor_runs(token),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  scope TEXT NOT NULL,
  source TEXT,
  item_id TEXT,
  source_generation INTEGER,
  item_claim_token TEXT,
  outcome TEXT NOT NULL,
  error_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_processor_incident_heads (
  epoch INTEGER PRIMARY KEY,
  origin_run_token TEXT NOT NULL REFERENCES source_processor_incidents(origin_run_token)
);
CREATE TABLE IF NOT EXISTS source_processor_detail_settlements (
  run_token TEXT NOT NULL REFERENCES source_processor_runs(token),
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK(source_generation>=0),
  item_claim_token TEXT NOT NULL CHECK(length(item_claim_token)=36),
  result_token TEXT NOT NULL CHECK(length(result_token)=36),
  outcome TEXT NOT NULL CHECK(outcome IN ('processed','ignored','manual_review','retry')),
  error_code TEXT,
  validated INTEGER NOT NULL CHECK(validated IN (0,1)),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  body_hash TEXT,
  revision_hash TEXT,
  semantic_hash TEXT,
  item_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_token,source,item_id,source_generation)
);
CREATE TABLE IF NOT EXISTS source_processor_recovery_receipts (
  recovery_run_token TEXT PRIMARY KEY REFERENCES source_processor_runs(token),
  origin_run_token TEXT NOT NULL REFERENCES source_processor_incidents(origin_run_token),
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  item_claim_token TEXT NOT NULL,
  result_token TEXT NOT NULL,
  validated INTEGER NOT NULL CHECK(validated IN (0,1)),
  registered_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_processor_control_reservations (
  recovery_run_token TEXT NOT NULL REFERENCES source_processor_runs(token),
  request_id TEXT NOT NULL,
  claim_token TEXT NOT NULL UNIQUE CHECK(length(claim_token)=36),
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  item_json TEXT NOT NULL CHECK(json_valid(item_json)),
  body_hash TEXT NOT NULL,
  revision_hash TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  request_profile_hash TEXT NOT NULL CHECK(length(request_profile_hash)=64),
  created_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  PRIMARY KEY(recovery_run_token,request_id)
);
CREATE TABLE IF NOT EXISTS source_processor_control_results (
  claim_token TEXT PRIMARY KEY REFERENCES source_processor_control_reservations(claim_token),
  payload_hash TEXT NOT NULL,
  validated INTEGER NOT NULL CHECK(validated IN (0,1)),
  http_status INTEGER,
  error_code TEXT,
  response_hash TEXT NOT NULL CHECK(length(response_hash)=64),
  request_profile_hash TEXT NOT NULL CHECK(length(request_profile_hash)=64),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_processor_recovery_probes (
  proof_id TEXT PRIMARY KEY CHECK(length(proof_id)=36),
  recovery_run_token TEXT NOT NULL REFERENCES source_processor_runs(token),
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  origin_run_token TEXT NOT NULL REFERENCES source_processor_incidents(origin_run_token),
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  item_claim_token TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  body_hash TEXT,
  revision_hash TEXT,
  failed_error_code TEXT NOT NULL,
  failed_http_status INTEGER,
  response_hash TEXT NOT NULL CHECK(length(response_hash)=64),
  request_profile_hash TEXT NOT NULL CHECK(length(request_profile_hash)=64),
  control_claim_token TEXT REFERENCES source_processor_control_reservations(claim_token),
  comparable INTEGER NOT NULL CHECK(comparable IN (0,1)),
  proof_impossible_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(recovery_run_token,request_id)
);
CREATE TABLE IF NOT EXISTS source_processor_item_exceptions (
  exception_id TEXT PRIMARY KEY CHECK(length(exception_id)=36),
  proof_id TEXT NOT NULL REFERENCES source_processor_recovery_probes(proof_id),
  recovery_run_token TEXT NOT NULL REFERENCES source_processor_runs(token),
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  review_generation INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  body_hash TEXT,
  revision_hash TEXT,
  item_claim_token TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('comparable-control','force')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  force_confirmed INTEGER NOT NULL CHECK(force_confirmed IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(recovery_run_token,request_id),
  UNIQUE(source,item_id,review_generation),
  CHECK((mode='force')=force_confirmed)
);
-- A separate positive canonical resolution preserves the append-only exception.
CREATE TABLE IF NOT EXISTS source_processor_exception_resolutions (
  exception_id TEXT PRIMARY KEY REFERENCES source_processor_item_exceptions(exception_id),
  run_token TEXT NOT NULL REFERENCES source_processor_runs(token),
  result_token TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  revision_hash TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS source_processor_incidents_update_immutable BEFORE UPDATE ON source_processor_incidents BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_incidents_delete_immutable BEFORE DELETE ON source_processor_incidents BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_incidents_replace_immutable BEFORE INSERT ON source_processor_incidents WHEN EXISTS(SELECT 1 FROM source_processor_incidents WHERE origin_run_token=NEW.origin_run_token) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_detail_settlements_update_immutable BEFORE UPDATE ON source_processor_detail_settlements BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_detail_settlements_delete_immutable BEFORE DELETE ON source_processor_detail_settlements BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_detail_settlements_replace_immutable BEFORE INSERT ON source_processor_detail_settlements WHEN EXISTS(SELECT 1 FROM source_processor_detail_settlements WHERE run_token=NEW.run_token AND source=NEW.source AND item_id=NEW.item_id AND source_generation=NEW.source_generation) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_recovery_receipts_update_immutable BEFORE UPDATE ON source_processor_recovery_receipts BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_recovery_receipts_delete_immutable BEFORE DELETE ON source_processor_recovery_receipts BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_recovery_receipts_replace_immutable BEFORE INSERT ON source_processor_recovery_receipts WHEN EXISTS(SELECT 1 FROM source_processor_recovery_receipts WHERE recovery_run_token=NEW.recovery_run_token) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_control_reservations_update_immutable BEFORE UPDATE ON source_processor_control_reservations BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_control_reservations_delete_immutable BEFORE DELETE ON source_processor_control_reservations BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_control_reservations_replace_immutable BEFORE INSERT ON source_processor_control_reservations WHEN EXISTS(SELECT 1 FROM source_processor_control_reservations WHERE recovery_run_token=NEW.recovery_run_token AND request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_control_results_update_immutable BEFORE UPDATE ON source_processor_control_results BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_control_results_delete_immutable BEFORE DELETE ON source_processor_control_results BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_control_results_replace_immutable BEFORE INSERT ON source_processor_control_results WHEN EXISTS(SELECT 1 FROM source_processor_control_results WHERE claim_token=NEW.claim_token) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_recovery_probes_update_immutable BEFORE UPDATE ON source_processor_recovery_probes BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_recovery_probes_delete_immutable BEFORE DELETE ON source_processor_recovery_probes BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_recovery_probes_replace_immutable BEFORE INSERT ON source_processor_recovery_probes WHEN EXISTS(SELECT 1 FROM source_processor_recovery_probes WHERE proof_id=NEW.proof_id) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_item_exceptions_update_immutable BEFORE UPDATE ON source_processor_item_exceptions BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_item_exceptions_delete_immutable BEFORE DELETE ON source_processor_item_exceptions BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_item_exceptions_replace_immutable BEFORE INSERT ON source_processor_item_exceptions WHEN EXISTS(SELECT 1 FROM source_processor_item_exceptions WHERE exception_id=NEW.exception_id) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_exception_resolutions_update_immutable BEFORE UPDATE ON source_processor_exception_resolutions BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_exception_resolutions_delete_immutable BEFORE DELETE ON source_processor_exception_resolutions BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_exception_resolutions_replace_immutable BEFORE INSERT ON source_processor_exception_resolutions WHEN EXISTS(SELECT 1 FROM source_processor_exception_resolutions WHERE exception_id=NEW.exception_id) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TABLE IF NOT EXISTS source_processor_proof_invalidations (
  proof_token TEXT PRIMARY KEY REFERENCES source_processor_runs(token),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  error_code TEXT NOT NULL CHECK(error_code='source_processor_proof_invalidated'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  invalidated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS source_processor_proof_invalidations_update_immutable BEFORE UPDATE ON source_processor_proof_invalidations BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_proof_invalidations_delete_immutable BEFORE DELETE ON source_processor_proof_invalidations BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_proof_invalidations_replace_immutable BEFORE INSERT ON source_processor_proof_invalidations WHEN EXISTS(SELECT 1 FROM source_processor_proof_invalidations WHERE proof_token=NEW.proof_token) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;

INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(17,CURRENT_TIMESTAMP);

-- Create-only current-generation recovery reservations. Original incidents remain immutable.
CREATE TABLE IF NOT EXISTS source_processor_target_reservations (
  recovery_run_token TEXT NOT NULL REFERENCES source_processor_runs(token),
  request_id TEXT NOT NULL,
  origin_run_token TEXT NOT NULL REFERENCES source_processor_incidents(origin_run_token),
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK(source_generation>=0),
  item_claim_token TEXT NOT NULL CHECK(length(item_claim_token)=36),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  body_hash TEXT,
  revision_hash TEXT,
  created_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  PRIMARY KEY(recovery_run_token,request_id)
);
CREATE TRIGGER IF NOT EXISTS source_processor_target_reservations_update_immutable BEFORE UPDATE ON source_processor_target_reservations BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_target_reservations_delete_immutable BEFORE DELETE ON source_processor_target_reservations BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_target_reservations_replace_immutable BEFORE INSERT ON source_processor_target_reservations WHEN EXISTS(SELECT 1 FROM source_processor_target_reservations WHERE recovery_run_token=NEW.recovery_run_token AND request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(18,CURRENT_TIMESTAMP);

-- Create-only operator exception audit. Shared credentials do not verify person identity.
CREATE TABLE IF NOT EXISTS source_processor_exception_audits (
  exception_id TEXT PRIMARY KEY NOT NULL REFERENCES source_processor_item_exceptions(exception_id),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS source_processor_exception_audits_update_immutable BEFORE UPDATE ON source_processor_exception_audits BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_exception_audits_delete_immutable BEFORE DELETE ON source_processor_exception_audits BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_processor_exception_audits_replace_immutable BEFORE INSERT ON source_processor_exception_audits WHEN EXISTS(SELECT 1 FROM source_processor_exception_audits WHERE exception_id=NEW.exception_id) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(19,CURRENT_TIMESTAMP);

-- Create-only local recovery support. This file does not reset any live cursor.
CREATE TABLE IF NOT EXISTS source_poll_recovery_previews (
  preview_id TEXT PRIMARY KEY NOT NULL CHECK(length(preview_id)=36),
  source TEXT NOT NULL CHECK(source IN ('naver-board-48','naver-board-56')),
  environment TEXT NOT NULL CHECK(environment IN ('staging','production')),
  deployment_sha TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  before_hash TEXT NOT NULL CHECK(length(before_hash)=64),
  page_json TEXT NOT NULL CHECK(json_valid(page_json)),
  page_hash TEXT NOT NULL CHECK(length(page_hash)=64),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  proof_hash TEXT NOT NULL CHECK(length(proof_hash)=64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at>created_at)
);
CREATE TABLE IF NOT EXISTS source_poll_recovery_audits (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK(length(operation_id)=36),
  preview_id TEXT NOT NULL UNIQUE REFERENCES source_poll_recovery_previews(preview_id),
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  source TEXT NOT NULL CHECK(source IN ('naver-board-48','naver-board-56')),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  page_hash TEXT NOT NULL CHECK(length(page_hash)=64),
  unverified_from TEXT,
  unverified_through TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS source_poll_recovery_history_idx ON source_poll_recovery_audits(source,unverified_through);
CREATE TRIGGER IF NOT EXISTS source_poll_recovery_previews_update_immutable BEFORE UPDATE ON source_poll_recovery_previews BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_poll_recovery_previews_delete_immutable BEFORE DELETE ON source_poll_recovery_previews BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_poll_recovery_previews_replace_immutable BEFORE INSERT ON source_poll_recovery_previews WHEN EXISTS(SELECT 1 FROM source_poll_recovery_previews WHERE preview_id=NEW.preview_id) BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_poll_recovery_audits_update_immutable BEFORE UPDATE ON source_poll_recovery_audits BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_poll_recovery_audits_delete_immutable BEFORE DELETE ON source_poll_recovery_audits BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_poll_recovery_audits_replace_immutable BEFORE INSERT ON source_poll_recovery_audits WHEN EXISTS(SELECT 1 FROM source_poll_recovery_audits WHERE operation_id=NEW.operation_id) BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(20,CURRENT_TIMESTAMP);

-- Create-only marker-preserving recovery audit. No cursor or existing evidence is rewritten.
-- No unverified interval columns: coverage is decided by the subsequent ordinary scan.
CREATE TABLE IF NOT EXISTS source_poll_marker_recovery_audits (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK(length(operation_id)=36),
  preview_id TEXT NOT NULL UNIQUE REFERENCES source_poll_recovery_previews(preview_id),
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  source TEXT NOT NULL CHECK(source IN ('naver-board-48','naver-board-56')),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  page_hash TEXT NOT NULL CHECK(length(page_hash)=64),
  applied_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS source_poll_marker_recovery_history_idx ON source_poll_marker_recovery_audits(source,applied_at);
CREATE TRIGGER IF NOT EXISTS source_poll_marker_recovery_audits_update_immutable BEFORE UPDATE ON source_poll_marker_recovery_audits BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_poll_marker_recovery_audits_delete_immutable BEFORE DELETE ON source_poll_marker_recovery_audits BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_poll_marker_recovery_audits_replace_immutable BEFORE INSERT ON source_poll_marker_recovery_audits WHEN EXISTS(SELECT 1 FROM source_poll_marker_recovery_audits WHERE operation_id=NEW.operation_id OR preview_id=NEW.preview_id OR request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
-- Additive protection for all existing audit UNIQUE keys. Migration20 and its rows remain unchanged.
CREATE TRIGGER IF NOT EXISTS source_poll_recovery_audits_unique_evidence_immutable BEFORE INSERT ON source_poll_recovery_audits WHEN EXISTS(SELECT 1 FROM source_poll_recovery_audits WHERE operation_id=NEW.operation_id OR preview_id=NEW.preview_id OR request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(21,CURRENT_TIMESTAMP);
