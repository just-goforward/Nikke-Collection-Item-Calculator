-- Rebuild the schema-26 dependency closure atomically. Restore historical rows before validation triggers.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE "backup27_source_watermarks" AS SELECT * FROM "source_watermarks";
CREATE TABLE "backup27_source_items" AS SELECT * FROM "source_items";
CREATE TABLE "backup27_source_poll_state" AS SELECT * FROM "source_poll_state";
CREATE TABLE "backup27_source_queue" AS SELECT * FROM "source_queue";
CREATE TABLE "backup27_source_manual_reviews" AS SELECT * FROM "source_manual_reviews";
CREATE TABLE "backup27_source_collection_health" AS SELECT * FROM "source_collection_health";
CREATE TABLE "backup27_source_processor_state" AS SELECT * FROM "source_processor_state";
CREATE TABLE "backup27_source_processor_runs" AS SELECT * FROM "source_processor_runs";
CREATE TABLE "backup27_source_poll_recovery_previews" AS SELECT * FROM "source_poll_recovery_previews";
CREATE TABLE "backup27_source_poll_recovery_audits" AS SELECT * FROM "source_poll_recovery_audits";
CREATE TABLE "backup27_source_poll_marker_recovery_audits" AS SELECT * FROM "source_poll_marker_recovery_audits";
CREATE TABLE "backup27_schedule_events" AS SELECT * FROM "schedule_events";
CREATE TABLE "backup27_forecast_candidates" AS SELECT * FROM "forecast_candidates";
CREATE TABLE "backup27_candidate_sources" AS SELECT * FROM "candidate_sources";
CREATE TABLE "backup27_source_processing_claims" AS SELECT * FROM "source_processing_claims";
CREATE TABLE "backup27_forecast_candidate_semantics" AS SELECT * FROM "forecast_candidate_semantics";
CREATE TABLE "backup27_source_manual_resolution_evidence" AS SELECT * FROM "source_manual_resolution_evidence";
CREATE TABLE "backup27_source_manual_review_bindings" AS SELECT * FROM "source_manual_review_bindings";
CREATE TABLE "backup27_schedule_event_source_revisions" AS SELECT * FROM "schedule_event_source_revisions";
CREATE TABLE "backup27_source_legacy_event_baselines" AS SELECT * FROM "source_legacy_event_baselines";
CREATE TABLE "backup27_source_metadata_observations" AS SELECT * FROM "source_metadata_observations";
CREATE TABLE "backup27_source_poll_scan_status" AS SELECT * FROM "source_poll_scan_status";
CREATE TABLE "backup27_source_processor_item_bindings" AS SELECT * FROM "source_processor_item_bindings";
CREATE TABLE "backup27_source_processor_incidents" AS SELECT * FROM "source_processor_incidents";
CREATE TABLE "backup27_source_processor_incident_heads" AS SELECT * FROM "source_processor_incident_heads";
CREATE TABLE "backup27_source_processor_detail_settlements" AS SELECT * FROM "source_processor_detail_settlements";
CREATE TABLE "backup27_source_processor_recovery_receipts" AS SELECT * FROM "source_processor_recovery_receipts";
CREATE TABLE "backup27_source_processor_control_reservations" AS SELECT * FROM "source_processor_control_reservations";
CREATE TABLE "backup27_source_processor_control_results" AS SELECT * FROM "source_processor_control_results";
CREATE TABLE "backup27_source_processor_recovery_probes" AS SELECT * FROM "source_processor_recovery_probes";
CREATE TABLE "backup27_source_processor_item_exceptions" AS SELECT * FROM "source_processor_item_exceptions";
CREATE TABLE "backup27_source_processor_exception_resolutions" AS SELECT * FROM "source_processor_exception_resolutions";
CREATE TABLE "backup27_source_processor_proof_invalidations" AS SELECT * FROM "source_processor_proof_invalidations";
CREATE TABLE "backup27_source_processor_target_reservations" AS SELECT * FROM "source_processor_target_reservations";
CREATE TABLE "backup27_source_processor_exception_audits" AS SELECT * FROM "source_processor_exception_audits";
CREATE TABLE "backup27_forecast_runtime_admissions" AS SELECT * FROM "forecast_runtime_admissions";
CREATE TABLE "backup27_forecast_runtime_versions" AS SELECT * FROM "forecast_runtime_versions";
CREATE TABLE "backup27_forecast_runtime_reviews" AS SELECT * FROM "forecast_runtime_reviews";
CREATE TABLE "backup27_forecast_runtime_commands" AS SELECT * FROM "forecast_runtime_commands";
CREATE TABLE "backup27_forecast_runtime_approvals" AS SELECT * FROM "forecast_runtime_approvals";
CREATE TABLE "backup27_forecast_runtime_active" AS SELECT * FROM "forecast_runtime_active";
CREATE TABLE "backup27_forecast_runtime_activation_history" AS SELECT * FROM "forecast_runtime_activation_history";
CREATE TABLE "backup27_forecast_runtime_outbox" AS SELECT * FROM "forecast_runtime_outbox";
CREATE TABLE "backup27_runtime_ingestion_runs" AS SELECT * FROM "runtime_ingestion_runs";
CREATE TABLE "backup27_runtime_notice_requests" AS SELECT * FROM "runtime_notice_requests";
CREATE TABLE "backup27_runtime_ingestion_items" AS SELECT * FROM "runtime_ingestion_items";
CREATE TABLE "backup27_runtime_ingestion_commits" AS SELECT * FROM "runtime_ingestion_commits";
DROP TRIGGER "source_manual_review_bindings_update_immutable";
DROP TRIGGER "source_manual_review_bindings_delete_immutable";
DROP TRIGGER "source_manual_resolution_evidence_update_immutable";
DROP TRIGGER "source_manual_resolution_evidence_delete_immutable";
DROP TRIGGER "source_manual_review_bindings_replace_immutable";
DROP TRIGGER "source_manual_resolution_evidence_replace_immutable";
DROP TRIGGER "source_legacy_event_baselines_update_immutable";
DROP TRIGGER "source_legacy_event_baselines_delete_immutable";
DROP TRIGGER "source_legacy_event_baselines_replace_immutable";
DROP TRIGGER "source_processor_incidents_update_immutable";
DROP TRIGGER "source_processor_incidents_delete_immutable";
DROP TRIGGER "source_processor_incidents_replace_immutable";
DROP TRIGGER "source_processor_detail_settlements_update_immutable";
DROP TRIGGER "source_processor_detail_settlements_delete_immutable";
DROP TRIGGER "source_processor_detail_settlements_replace_immutable";
DROP TRIGGER "source_processor_recovery_receipts_update_immutable";
DROP TRIGGER "source_processor_recovery_receipts_delete_immutable";
DROP TRIGGER "source_processor_recovery_receipts_replace_immutable";
DROP TRIGGER "source_processor_control_reservations_update_immutable";
DROP TRIGGER "source_processor_control_reservations_delete_immutable";
DROP TRIGGER "source_processor_control_reservations_replace_immutable";
DROP TRIGGER "source_processor_control_results_update_immutable";
DROP TRIGGER "source_processor_control_results_delete_immutable";
DROP TRIGGER "source_processor_control_results_replace_immutable";
DROP TRIGGER "source_processor_recovery_probes_update_immutable";
DROP TRIGGER "source_processor_recovery_probes_delete_immutable";
DROP TRIGGER "source_processor_recovery_probes_replace_immutable";
DROP TRIGGER "source_processor_item_exceptions_update_immutable";
DROP TRIGGER "source_processor_item_exceptions_delete_immutable";
DROP TRIGGER "source_processor_item_exceptions_replace_immutable";
DROP TRIGGER "source_processor_exception_resolutions_update_immutable";
DROP TRIGGER "source_processor_exception_resolutions_delete_immutable";
DROP TRIGGER "source_processor_exception_resolutions_replace_immutable";
DROP TRIGGER "source_processor_proof_invalidations_update_immutable";
DROP TRIGGER "source_processor_proof_invalidations_delete_immutable";
DROP TRIGGER "source_processor_proof_invalidations_replace_immutable";
DROP TRIGGER "source_processor_target_reservations_update_immutable";
DROP TRIGGER "source_processor_target_reservations_delete_immutable";
DROP TRIGGER "source_processor_target_reservations_replace_immutable";
DROP TRIGGER "source_processor_exception_audits_update_immutable";
DROP TRIGGER "source_processor_exception_audits_delete_immutable";
DROP TRIGGER "source_processor_exception_audits_replace_immutable";
DROP TRIGGER "source_poll_recovery_previews_update_immutable";
DROP TRIGGER "source_poll_recovery_previews_delete_immutable";
DROP TRIGGER "source_poll_recovery_previews_replace_immutable";
DROP TRIGGER "source_poll_recovery_audits_update_immutable";
DROP TRIGGER "source_poll_recovery_audits_delete_immutable";
DROP TRIGGER "source_poll_recovery_audits_replace_immutable";
DROP TRIGGER "source_poll_marker_recovery_audits_update_immutable";
DROP TRIGGER "source_poll_marker_recovery_audits_delete_immutable";
DROP TRIGGER "source_poll_marker_recovery_audits_replace_immutable";
DROP TRIGGER "source_poll_recovery_audits_unique_evidence_immutable";
DROP TRIGGER "forecast_runtime_versions_validate";
DROP TRIGGER "forecast_runtime_versions_update";
DROP TRIGGER "forecast_runtime_versions_delete";
DROP TRIGGER "forecast_runtime_versions_replace";
DROP TRIGGER "forecast_runtime_candidate_update";
DROP TRIGGER "forecast_runtime_candidate_delete";
DROP TRIGGER "forecast_runtime_candidate_replace";
DROP TRIGGER "forecast_runtime_review_validate";
DROP TRIGGER "forecast_runtime_approval_validate";
DROP TRIGGER "forecast_runtime_activation_validate";
DROP TRIGGER "forecast_runtime_activation_apply";
DROP TRIGGER "forecast_runtime_active_insert";
DROP TRIGGER "forecast_runtime_active_update";
DROP TRIGGER "forecast_runtime_active_delete";
DROP TRIGGER "forecast_runtime_reviews_update";
DROP TRIGGER "forecast_runtime_reviews_delete";
DROP TRIGGER "forecast_runtime_reviews_replace";
DROP TRIGGER "forecast_runtime_approvals_update";
DROP TRIGGER "forecast_runtime_approvals_delete";
DROP TRIGGER "forecast_runtime_approvals_replace";
DROP TRIGGER "forecast_runtime_history_update";
DROP TRIGGER "forecast_runtime_history_delete";
DROP TRIGGER "forecast_runtime_history_replace";
DROP TRIGGER "forecast_runtime_commands_identity";
DROP TRIGGER "forecast_runtime_commands_delete";
DROP TRIGGER "forecast_runtime_commands_replace";
DROP TRIGGER "forecast_runtime_outbox_identity";
DROP TRIGGER "forecast_runtime_outbox_delete";
DROP TRIGGER "forecast_runtime_outbox_replace";
DROP TRIGGER "forecast_runtime_approved_candidate_update";
DROP TRIGGER "forecast_runtime_approved_source_update";
DROP TRIGGER "forecast_runtime_approved_source_delete";
DROP TRIGGER "forecast_runtime_approved_source_insert";
DROP TRIGGER "runtime_ingestion_commit_fence";
DROP TRIGGER "runtime_ingestion_commits_immutable_update";
DROP TRIGGER "runtime_ingestion_commits_immutable_delete";
DROP TRIGGER "runtime_notice_request_identity_update";
DROP TRIGGER "runtime_notice_request_delete";
DROP TRIGGER "runtime_notice_request_replace";
DROP TABLE "runtime_ingestion_commits";
DROP TABLE "runtime_ingestion_items";
DROP TABLE "runtime_notice_requests";
DROP TABLE "runtime_ingestion_runs";
DROP TABLE "forecast_runtime_outbox";
DROP TABLE "forecast_runtime_activation_history";
DROP TABLE "forecast_runtime_active";
DROP TABLE "forecast_runtime_approvals";
DROP TABLE "forecast_runtime_commands";
DROP TABLE "forecast_runtime_reviews";
DROP TABLE "forecast_runtime_versions";
DROP TABLE "forecast_runtime_admissions";
DROP TABLE "source_processor_exception_audits";
DROP TABLE "source_processor_target_reservations";
DROP TABLE "source_processor_proof_invalidations";
DROP TABLE "source_processor_exception_resolutions";
DROP TABLE "source_processor_item_exceptions";
DROP TABLE "source_processor_recovery_probes";
DROP TABLE "source_processor_control_results";
DROP TABLE "source_processor_control_reservations";
DROP TABLE "source_processor_recovery_receipts";
DROP TABLE "source_processor_detail_settlements";
DROP TABLE "source_processor_incident_heads";
DROP TABLE "source_processor_incidents";
DROP TABLE "source_processor_item_bindings";
DROP TABLE "source_poll_scan_status";
DROP TABLE "source_metadata_observations";
DROP TABLE "source_legacy_event_baselines";
DROP TABLE "schedule_event_source_revisions";
DROP TABLE "source_manual_review_bindings";
DROP TABLE "source_manual_resolution_evidence";
DROP TABLE "forecast_candidate_semantics";
DROP TABLE "source_processing_claims";
DROP TABLE "candidate_sources";
DROP TABLE "forecast_candidates";
DROP TABLE "schedule_events";
DROP TABLE "source_poll_marker_recovery_audits";
DROP TABLE "source_poll_recovery_audits";
DROP TABLE "source_poll_recovery_previews";
DROP TABLE "source_processor_runs";
DROP TABLE "source_processor_state";
DROP TABLE "source_collection_health";
DROP TABLE "source_manual_reviews";
DROP TABLE "source_queue";
DROP TABLE "source_poll_state";
DROP TABLE "source_items";
DROP TABLE "source_watermarks";
CREATE TABLE source_watermarks (
  source TEXT PRIMARY KEY CHECK (source IN ('naver-board-11','naver-board-48', 'naver-board-56', 'x-nikke-kr')),
  item_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  updated_at TEXT NOT NULL
);
CREATE TABLE source_items (
  source TEXT NOT NULL CHECK (source IN ('naver-board-11','naver-board-48', 'naver-board-56', 'x-nikke-kr')),
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
CREATE TABLE source_poll_state (
  source TEXT PRIMARY KEY CHECK (source IN ('naver-board-11','naver-board-48', 'naver-board-56')),
  committed_item_id TEXT,
  committed_published_at TEXT,
  scan_head_item_id TEXT,
  scan_head_published_at TEXT,
  next_offset INTEGER NOT NULL DEFAULT 0 CHECK (next_offset >= 0),
  updated_at TEXT NOT NULL, page_size INTEGER NOT NULL DEFAULT 10 CHECK (page_size IN (5, 10)),
  CHECK ((committed_item_id IS NULL) = (committed_published_at IS NULL)),
  CHECK ((scan_head_item_id IS NULL) = (scan_head_published_at IS NULL))
);
CREATE TABLE source_queue (
  source TEXT NOT NULL CHECK (source IN ('naver-board-11','naver-board-48', 'naver-board-56')),
  item_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  official INTEGER NOT NULL CHECK (official IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'ignored', 'manual_review')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, review_generation INTEGER NOT NULL DEFAULT 0 CHECK (review_generation >= 0),
  PRIMARY KEY (source, item_id)
);
CREATE TABLE source_manual_reviews (
  review_id TEXT PRIMARY KEY CHECK (
    substr(review_id, 1, 3) = 'mr-' AND length(review_id) = 35
      AND substr(review_id, 4) NOT GLOB '*[^0-9a-f]*'
  ),
  source TEXT NOT NULL CHECK (source IN ('naver-board-11','naver-board-48', 'naver-board-56')),
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
CREATE TABLE source_collection_health (
  source TEXT PRIMARY KEY CHECK (source IN ('naver-board-11','naver-board-48','naver-board-56')),
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  scan_complete INTEGER NOT NULL DEFAULT 0 CHECK (scan_complete IN (0,1)),
  schema_drift INTEGER NOT NULL DEFAULT 0 CHECK (schema_drift IN (0,1)),
  gap_detected INTEGER NOT NULL DEFAULT 0 CHECK (gap_detected IN (0,1)),
  gap_since_at TEXT,
  collection_failures INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);
CREATE TABLE source_processor_state (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch>=1),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','retry','held','verifying','verified')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 3),
  next_retry_at TEXT,
  active_token TEXT CHECK(active_token IS NULL OR length(active_token)=36),
  lease_until TEXT,
  last_error_code TEXT,
  failed_scope TEXT CHECK(failed_scope IS NULL OR failed_scope IN ('pipeline','metadata','daily','claim','detail','refresh')),
  failed_source TEXT CHECK(failed_source IS NULL OR failed_source IN ('naver-board-11','naver-board-48','naver-board-56')),
  failed_item_id TEXT,
  failed_generation INTEGER CHECK(failed_generation IS NULL OR failed_generation>=0),
  updated_at TEXT NOT NULL,
  CHECK((active_token IS NULL)=(lease_until IS NULL))
);
CREATE TABLE source_processor_runs (
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
  failed_source TEXT CHECK(failed_source IS NULL OR failed_source IN ('naver-board-11','naver-board-48','naver-board-56')),
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
CREATE TABLE source_poll_recovery_previews (
  preview_id TEXT PRIMARY KEY NOT NULL CHECK(length(preview_id)=36),
  source TEXT NOT NULL CHECK(source IN ('naver-board-11','naver-board-48','naver-board-56')),
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
CREATE TABLE source_poll_recovery_audits (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK(length(operation_id)=36),
  preview_id TEXT NOT NULL UNIQUE REFERENCES source_poll_recovery_previews(preview_id),
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  source TEXT NOT NULL CHECK(source IN ('naver-board-11','naver-board-48','naver-board-56')),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  page_hash TEXT NOT NULL CHECK(length(page_hash)=64),
  unverified_from TEXT,
  unverified_through TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE source_poll_marker_recovery_audits (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK(length(operation_id)=36),
  preview_id TEXT NOT NULL UNIQUE REFERENCES source_poll_recovery_previews(preview_id),
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  source TEXT NOT NULL CHECK(source IN ('naver-board-11','naver-board-48','naver-board-56')),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  page_hash TEXT NOT NULL CHECK(length(page_hash)=64),
  applied_at TEXT NOT NULL
);
CREATE TABLE schedule_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('solo', 'cooperation', 'collaboration', 'schedule_change', 'reward', 'grant')
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
CREATE TABLE forecast_candidates (
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
CREATE TABLE candidate_sources (
  candidate_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  PRIMARY KEY (candidate_id, source, source_item_id),
  FOREIGN KEY (candidate_id) REFERENCES forecast_candidates(candidate_id),
  FOREIGN KEY (source, source_item_id) REFERENCES source_items(source, item_id)
);
CREATE TABLE source_processing_claims (
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
CREATE TABLE forecast_candidate_semantics (
  semantic_hash TEXT NOT NULL CHECK(length(semantic_hash)=64),
  candidate_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES forecast_candidates(candidate_id)
);
CREATE TABLE source_manual_resolution_evidence (
  review_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  created_at TEXT NOT NULL,
  FOREIGN KEY(review_id) REFERENCES source_manual_reviews(review_id)
);
CREATE TABLE source_manual_review_bindings (
  review_id TEXT PRIMARY KEY, source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  body_hash TEXT, revision_hash TEXT, semantic_hash TEXT, generation INTEGER NOT NULL,
  review_token TEXT NOT NULL CHECK(length(review_token)=64), metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  item_json TEXT CHECK(item_json IS NULL OR json_valid(item_json)), created_at TEXT NOT NULL,
  FOREIGN KEY(review_id) REFERENCES source_manual_reviews(review_id)
);
CREATE TABLE schedule_event_source_revisions (
  event_id TEXT PRIMARY KEY, source TEXT NOT NULL, item_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
  FOREIGN KEY(event_id) REFERENCES schedule_events(event_id),
  FOREIGN KEY(source,item_id,source_revision) REFERENCES source_notice_revisions(source,item_id,source_revision)
);
CREATE TABLE source_legacy_event_baselines (
  event_id TEXT PRIMARY KEY,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  body_available INTEGER NOT NULL DEFAULT 0 CHECK(body_available=0),
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(event_id) REFERENCES schedule_events(event_id)
);
CREATE TABLE source_metadata_observations (
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  metadata_hash TEXT NOT NULL CHECK(length(metadata_hash)=64),
  review_generation INTEGER NOT NULL CHECK(review_generation>=0),
  invalid INTEGER NOT NULL CHECK(invalid IN (0,1)),
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(source,item_id),
  FOREIGN KEY(source,item_id) REFERENCES source_queue(source,item_id)
);
CREATE TABLE source_poll_scan_status (
  source TEXT PRIMARY KEY,
  scan_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(scan_uncertain IN (0,1)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(source) REFERENCES source_poll_state(source)
);
CREATE TABLE source_processor_item_bindings (
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
CREATE TABLE source_processor_incidents (
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
CREATE TABLE source_processor_incident_heads (
  epoch INTEGER PRIMARY KEY,
  origin_run_token TEXT NOT NULL REFERENCES source_processor_incidents(origin_run_token)
);
CREATE TABLE source_processor_detail_settlements (
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
CREATE TABLE source_processor_recovery_receipts (
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
CREATE TABLE source_processor_control_reservations (
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
CREATE TABLE source_processor_control_results (
  claim_token TEXT PRIMARY KEY REFERENCES source_processor_control_reservations(claim_token),
  payload_hash TEXT NOT NULL,
  validated INTEGER NOT NULL CHECK(validated IN (0,1)),
  http_status INTEGER,
  error_code TEXT,
  response_hash TEXT NOT NULL CHECK(length(response_hash)=64),
  request_profile_hash TEXT NOT NULL CHECK(length(request_profile_hash)=64),
  created_at TEXT NOT NULL
);
CREATE TABLE source_processor_recovery_probes (
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
CREATE TABLE source_processor_item_exceptions (
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
CREATE TABLE source_processor_exception_resolutions (
  exception_id TEXT PRIMARY KEY REFERENCES source_processor_item_exceptions(exception_id),
  run_token TEXT NOT NULL REFERENCES source_processor_runs(token),
  result_token TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  revision_hash TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);
CREATE TABLE source_processor_proof_invalidations (
  proof_token TEXT PRIMARY KEY REFERENCES source_processor_runs(token),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  error_code TEXT NOT NULL CHECK(error_code='source_processor_proof_invalidated'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  invalidated_at TEXT NOT NULL
);
CREATE TABLE source_processor_target_reservations (
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
CREATE TABLE source_processor_exception_audits (
  exception_id TEXT PRIMARY KEY NOT NULL REFERENCES source_processor_item_exceptions(exception_id),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE forecast_runtime_admissions (
  candidate_id TEXT PRIMARY KEY NOT NULL REFERENCES forecast_candidates(candidate_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('pending','running','ready','dead')),
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 5),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  error_code TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE forecast_runtime_versions (
  candidate_id TEXT PRIMARY KEY NOT NULL REFERENCES forecast_candidates(candidate_id) ON DELETE RESTRICT,
  payload_hash TEXT NOT NULL UNIQUE CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  rules_version TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  snapshot_version TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes>0),
  sealed_at INTEGER NOT NULL CHECK(sealed_at>0),
  CHECK ((rules_version='schedule-kit-v3' AND payload_version=4 AND snapshot_version='certified-daily-v3')
    OR (rules_version='schedule-kit-v4' AND payload_version=5 AND snapshot_version='certified-daily-v4'))
);
CREATE TABLE forecast_runtime_reviews (
  review_id TEXT PRIMARY KEY NOT NULL CHECK(length(review_id)=32),
  review_key TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL CHECK(environment IN ('staging','production')),
  action TEXT NOT NULL CHECK(action IN ('approve','rollback','off')),
  candidate_id TEXT REFERENCES forecast_runtime_versions(candidate_id) ON DELETE RESTRICT,
  payload_hash TEXT,
  expected_sequence INTEGER NOT NULL CHECK(expected_sequence>=0),
  previous_candidate_id TEXT REFERENCES forecast_runtime_versions(candidate_id) ON DELETE RESTRICT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>0 AND expires_at>created_at),
  CHECK((action='off' AND candidate_id IS NULL AND payload_hash IS NULL) OR
    (action IN ('approve','rollback') AND candidate_id IS NOT NULL AND payload_hash IS NOT NULL AND length(payload_hash)=64))
);
CREATE TABLE forecast_runtime_commands (
  interaction_id TEXT PRIMARY KEY NOT NULL,
  review_id TEXT NOT NULL REFERENCES forecast_runtime_reviews(review_id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  actor_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','failed','applied')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  result_sequence INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE forecast_runtime_approvals (
  candidate_id TEXT PRIMARY KEY NOT NULL REFERENCES forecast_runtime_versions(candidate_id) ON DELETE RESTRICT,
  interaction_id TEXT NOT NULL UNIQUE REFERENCES forecast_runtime_commands(interaction_id) ON DELETE RESTRICT,
  environment TEXT NOT NULL CHECK(environment IN ('staging','production')),
  payload_hash TEXT NOT NULL,
  key_id TEXT NOT NULL,
  artifact_signature TEXT NOT NULL CHECK(length(artifact_signature)=88),
  actor_id TEXT NOT NULL,
  approved_at INTEGER NOT NULL
);
CREATE TABLE forecast_runtime_active (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  environment TEXT NOT NULL CHECK(environment IN ('staging','production')),
  sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<=9007199254740991),
  candidate_id TEXT REFERENCES forecast_runtime_approvals(candidate_id) ON DELETE RESTRICT,
  operation_id TEXT,
  signed_pointer_json TEXT CHECK(signed_pointer_json IS NULL OR json_valid(signed_pointer_json)),
  CHECK((sequence=0 AND candidate_id IS NULL AND operation_id IS NULL AND signed_pointer_json IS NULL)
    OR (sequence>0 AND operation_id IS NOT NULL AND signed_pointer_json IS NOT NULL))
);
CREATE TABLE forecast_runtime_activation_history (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES forecast_runtime_commands(interaction_id) ON DELETE RESTRICT,
  review_id TEXT NOT NULL UNIQUE REFERENCES forecast_runtime_reviews(review_id) ON DELETE RESTRICT,
  environment TEXT NOT NULL CHECK(environment IN ('staging','production')),
  action TEXT NOT NULL CHECK(action IN ('approve','rollback','off')),
  sequence INTEGER NOT NULL UNIQUE CHECK(sequence>0),
  previous_candidate_id TEXT REFERENCES forecast_runtime_approvals(candidate_id) ON DELETE RESTRICT,
  candidate_id TEXT REFERENCES forecast_runtime_approvals(candidate_id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  signed_pointer_json TEXT NOT NULL CHECK(json_valid(signed_pointer_json))
);
CREATE TABLE forecast_runtime_outbox (
  outbox_id TEXT PRIMARY KEY NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('staging','production')),
  kind TEXT NOT NULL CHECK(kind IN ('review','result')),
  review_id TEXT NOT NULL REFERENCES forecast_runtime_reviews(review_id) ON DELETE RESTRICT,
  operation_id TEXT UNIQUE REFERENCES forecast_runtime_activation_history(operation_id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  message_id TEXT,
  channel_id TEXT,
  error_code TEXT,
  CHECK((kind='review' AND operation_id IS NULL) OR (kind='result' AND operation_id IS NOT NULL))
);
CREATE TABLE runtime_ingestion_runs (
  token TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','expired')),
  started_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  candidate_id TEXT REFERENCES forecast_candidates(candidate_id)
);
CREATE TABLE runtime_notice_requests (
  request_id TEXT PRIMARY KEY,
  run_token TEXT NOT NULL REFERENCES runtime_ingestion_runs(token),
  utc_day TEXT NOT NULL,
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'reserved',
  error_code TEXT,
  content_hash TEXT,
  FOREIGN KEY(source,item_id) REFERENCES source_queue(source,item_id)
);
CREATE TABLE runtime_ingestion_items (
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  next_check_at TEXT NOT NULL,
  failures INTEGER NOT NULL CHECK(failures BETWEEN 0 AND 3),
  PRIMARY KEY(source,item_id),
  FOREIGN KEY(source,item_id) REFERENCES source_queue(source,item_id)
);
CREATE TABLE runtime_ingestion_commits (
  run_token TEXT PRIMARY KEY REFERENCES runtime_ingestion_runs(token),
  committed_at TEXT NOT NULL,
  queue_snapshot TEXT NOT NULL CHECK(json_valid(queue_snapshot))
);
INSERT INTO "source_watermarks" SELECT * FROM "backup27_source_watermarks";
INSERT INTO "source_items" SELECT * FROM "backup27_source_items";
INSERT INTO "source_poll_state" SELECT * FROM "backup27_source_poll_state";
INSERT INTO "source_queue" SELECT * FROM "backup27_source_queue";
INSERT INTO "source_manual_reviews" SELECT * FROM "backup27_source_manual_reviews";
INSERT INTO "source_collection_health" SELECT * FROM "backup27_source_collection_health";
INSERT INTO "source_processor_state" SELECT * FROM "backup27_source_processor_state";
INSERT INTO "source_processor_runs" SELECT * FROM "backup27_source_processor_runs";
INSERT INTO "source_poll_recovery_previews" SELECT * FROM "backup27_source_poll_recovery_previews";
INSERT INTO "source_poll_recovery_audits" SELECT * FROM "backup27_source_poll_recovery_audits";
INSERT INTO "source_poll_marker_recovery_audits" SELECT * FROM "backup27_source_poll_marker_recovery_audits";
INSERT INTO "schedule_events" SELECT * FROM "backup27_schedule_events";
INSERT INTO "forecast_candidates" SELECT * FROM "backup27_forecast_candidates";
INSERT INTO "candidate_sources" SELECT * FROM "backup27_candidate_sources";
INSERT INTO "source_processing_claims" SELECT * FROM "backup27_source_processing_claims";
INSERT INTO "forecast_candidate_semantics" SELECT * FROM "backup27_forecast_candidate_semantics";
INSERT INTO "source_manual_resolution_evidence" SELECT * FROM "backup27_source_manual_resolution_evidence";
INSERT INTO "source_manual_review_bindings" SELECT * FROM "backup27_source_manual_review_bindings";
INSERT INTO "schedule_event_source_revisions" SELECT * FROM "backup27_schedule_event_source_revisions";
INSERT INTO "source_legacy_event_baselines" SELECT * FROM "backup27_source_legacy_event_baselines";
INSERT INTO "source_metadata_observations" SELECT * FROM "backup27_source_metadata_observations";
INSERT INTO "source_poll_scan_status" SELECT * FROM "backup27_source_poll_scan_status";
INSERT INTO "source_processor_item_bindings" SELECT * FROM "backup27_source_processor_item_bindings";
INSERT INTO "source_processor_incidents" SELECT * FROM "backup27_source_processor_incidents";
INSERT INTO "source_processor_incident_heads" SELECT * FROM "backup27_source_processor_incident_heads";
INSERT INTO "source_processor_detail_settlements" SELECT * FROM "backup27_source_processor_detail_settlements";
INSERT INTO "source_processor_recovery_receipts" SELECT * FROM "backup27_source_processor_recovery_receipts";
INSERT INTO "source_processor_control_reservations" SELECT * FROM "backup27_source_processor_control_reservations";
INSERT INTO "source_processor_control_results" SELECT * FROM "backup27_source_processor_control_results";
INSERT INTO "source_processor_recovery_probes" SELECT * FROM "backup27_source_processor_recovery_probes";
INSERT INTO "source_processor_item_exceptions" SELECT * FROM "backup27_source_processor_item_exceptions";
INSERT INTO "source_processor_exception_resolutions" SELECT * FROM "backup27_source_processor_exception_resolutions";
INSERT INTO "source_processor_proof_invalidations" SELECT * FROM "backup27_source_processor_proof_invalidations";
INSERT INTO "source_processor_target_reservations" SELECT * FROM "backup27_source_processor_target_reservations";
INSERT INTO "source_processor_exception_audits" SELECT * FROM "backup27_source_processor_exception_audits";
INSERT INTO "forecast_runtime_admissions" SELECT * FROM "backup27_forecast_runtime_admissions";
INSERT INTO "forecast_runtime_versions" SELECT * FROM "backup27_forecast_runtime_versions";
INSERT INTO "forecast_runtime_reviews" SELECT * FROM "backup27_forecast_runtime_reviews";
INSERT INTO "forecast_runtime_commands" SELECT * FROM "backup27_forecast_runtime_commands";
INSERT INTO "forecast_runtime_approvals" SELECT * FROM "backup27_forecast_runtime_approvals";
INSERT INTO "forecast_runtime_active" SELECT * FROM "backup27_forecast_runtime_active";
INSERT INTO "forecast_runtime_activation_history" SELECT * FROM "backup27_forecast_runtime_activation_history";
INSERT INTO "forecast_runtime_outbox" SELECT * FROM "backup27_forecast_runtime_outbox";
INSERT INTO "runtime_ingestion_runs" SELECT * FROM "backup27_runtime_ingestion_runs";
INSERT INTO "runtime_notice_requests" SELECT * FROM "backup27_runtime_notice_requests";
INSERT INTO "runtime_ingestion_items" SELECT * FROM "backup27_runtime_ingestion_items";
INSERT INTO "runtime_ingestion_commits" SELECT * FROM "backup27_runtime_ingestion_commits";
CREATE INDEX schedule_events_type_start_idx
  ON schedule_events(event_type, starts_at DESC);
CREATE INDEX forecast_candidates_state_created_idx
  ON forecast_candidates(state, created_at);
CREATE INDEX source_queue_status_published_idx
  ON source_queue(status, published_at, item_id);
CREATE INDEX source_manual_reviews_state_created_idx
  ON source_manual_reviews(state, created_at, review_id);
CREATE INDEX source_processing_claims_retry_idx
  ON source_processing_claims(next_retry_at, lease_until);
CREATE UNIQUE INDEX forecast_candidates_day_revision_cas_idx
  ON forecast_candidates(game_day, revision);
CREATE INDEX idx_source_processor_runs_epoch ON source_processor_runs(epoch,started_at);
CREATE INDEX idx_source_processor_item_claim ON source_processor_item_bindings(item_claim_token,source,item_id);
CREATE INDEX source_poll_recovery_history_idx ON source_poll_recovery_audits(source,unverified_through);
CREATE INDEX source_poll_marker_recovery_history_idx ON source_poll_marker_recovery_audits(source,applied_at);
CREATE INDEX forecast_runtime_reviews_candidate_idx ON forecast_runtime_reviews(candidate_id,expected_sequence,expires_at);
CREATE INDEX forecast_runtime_outbox_due_idx ON forecast_runtime_outbox(environment,state,next_attempt_at);
CREATE UNIQUE INDEX runtime_ingestion_one_running
  ON runtime_ingestion_runs(status) WHERE status='running';
CREATE INDEX runtime_ingestion_runs_started_at
  ON runtime_ingestion_runs(started_at DESC);
CREATE INDEX runtime_notice_requests_day ON runtime_notice_requests(utc_day);
CREATE INDEX runtime_notice_requests_item ON runtime_notice_requests(source,item_id,reserved_at);
CREATE TRIGGER source_manual_review_bindings_update_immutable BEFORE UPDATE ON source_manual_review_bindings BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER source_manual_review_bindings_delete_immutable BEFORE DELETE ON source_manual_review_bindings BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER source_manual_resolution_evidence_update_immutable BEFORE UPDATE ON source_manual_resolution_evidence BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER source_manual_resolution_evidence_delete_immutable BEFORE DELETE ON source_manual_resolution_evidence BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER source_manual_review_bindings_replace_immutable BEFORE INSERT ON source_manual_review_bindings WHEN EXISTS(SELECT 1 FROM source_manual_review_bindings WHERE review_id=NEW.review_id) BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER source_manual_resolution_evidence_replace_immutable BEFORE INSERT ON source_manual_resolution_evidence WHEN EXISTS(SELECT 1 FROM source_manual_resolution_evidence WHERE review_id=NEW.review_id) BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER source_legacy_event_baselines_update_immutable BEFORE UPDATE ON source_legacy_event_baselines BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER source_legacy_event_baselines_delete_immutable BEFORE DELETE ON source_legacy_event_baselines BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER source_legacy_event_baselines_replace_immutable BEFORE INSERT ON source_legacy_event_baselines WHEN EXISTS(SELECT 1 FROM source_legacy_event_baselines WHERE event_id=NEW.event_id) BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER source_processor_incidents_update_immutable BEFORE UPDATE ON source_processor_incidents BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_incidents_delete_immutable BEFORE DELETE ON source_processor_incidents BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_incidents_replace_immutable BEFORE INSERT ON source_processor_incidents WHEN EXISTS(SELECT 1 FROM source_processor_incidents WHERE origin_run_token=NEW.origin_run_token) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_detail_settlements_update_immutable BEFORE UPDATE ON source_processor_detail_settlements BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_detail_settlements_delete_immutable BEFORE DELETE ON source_processor_detail_settlements BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_detail_settlements_replace_immutable BEFORE INSERT ON source_processor_detail_settlements WHEN EXISTS(SELECT 1 FROM source_processor_detail_settlements WHERE run_token=NEW.run_token AND source=NEW.source AND item_id=NEW.item_id AND source_generation=NEW.source_generation) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_recovery_receipts_update_immutable BEFORE UPDATE ON source_processor_recovery_receipts BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_recovery_receipts_delete_immutable BEFORE DELETE ON source_processor_recovery_receipts BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_recovery_receipts_replace_immutable BEFORE INSERT ON source_processor_recovery_receipts WHEN EXISTS(SELECT 1 FROM source_processor_recovery_receipts WHERE recovery_run_token=NEW.recovery_run_token) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_control_reservations_update_immutable BEFORE UPDATE ON source_processor_control_reservations BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_control_reservations_delete_immutable BEFORE DELETE ON source_processor_control_reservations BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
-- Harden inherited replacement gaps: immutable evidence protects every PRIMARY KEY and UNIQUE key.
CREATE TRIGGER source_processor_control_reservations_replace_immutable BEFORE INSERT ON source_processor_control_reservations WHEN EXISTS(SELECT 1 FROM source_processor_control_reservations WHERE (recovery_run_token=NEW.recovery_run_token AND request_id=NEW.request_id) OR claim_token=NEW.claim_token) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_control_results_update_immutable BEFORE UPDATE ON source_processor_control_results BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_control_results_delete_immutable BEFORE DELETE ON source_processor_control_results BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_control_results_replace_immutable BEFORE INSERT ON source_processor_control_results WHEN EXISTS(SELECT 1 FROM source_processor_control_results WHERE claim_token=NEW.claim_token) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_recovery_probes_update_immutable BEFORE UPDATE ON source_processor_recovery_probes BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_recovery_probes_delete_immutable BEFORE DELETE ON source_processor_recovery_probes BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_recovery_probes_replace_immutable BEFORE INSERT ON source_processor_recovery_probes WHEN EXISTS(SELECT 1 FROM source_processor_recovery_probes WHERE proof_id=NEW.proof_id OR (recovery_run_token=NEW.recovery_run_token AND request_id=NEW.request_id)) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_item_exceptions_update_immutable BEFORE UPDATE ON source_processor_item_exceptions BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_item_exceptions_delete_immutable BEFORE DELETE ON source_processor_item_exceptions BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_item_exceptions_replace_immutable BEFORE INSERT ON source_processor_item_exceptions WHEN EXISTS(SELECT 1 FROM source_processor_item_exceptions WHERE exception_id=NEW.exception_id OR (recovery_run_token=NEW.recovery_run_token AND request_id=NEW.request_id) OR (source=NEW.source AND item_id=NEW.item_id AND review_generation=NEW.review_generation)) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_exception_resolutions_update_immutable BEFORE UPDATE ON source_processor_exception_resolutions BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_exception_resolutions_delete_immutable BEFORE DELETE ON source_processor_exception_resolutions BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_exception_resolutions_replace_immutable BEFORE INSERT ON source_processor_exception_resolutions WHEN EXISTS(SELECT 1 FROM source_processor_exception_resolutions WHERE exception_id=NEW.exception_id) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_proof_invalidations_update_immutable BEFORE UPDATE ON source_processor_proof_invalidations BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_proof_invalidations_delete_immutable BEFORE DELETE ON source_processor_proof_invalidations BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_proof_invalidations_replace_immutable BEFORE INSERT ON source_processor_proof_invalidations WHEN EXISTS(SELECT 1 FROM source_processor_proof_invalidations WHERE proof_token=NEW.proof_token) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_target_reservations_update_immutable BEFORE UPDATE ON source_processor_target_reservations BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_target_reservations_delete_immutable BEFORE DELETE ON source_processor_target_reservations BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_target_reservations_replace_immutable BEFORE INSERT ON source_processor_target_reservations WHEN EXISTS(SELECT 1 FROM source_processor_target_reservations WHERE recovery_run_token=NEW.recovery_run_token AND request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_exception_audits_update_immutable BEFORE UPDATE ON source_processor_exception_audits BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_exception_audits_delete_immutable BEFORE DELETE ON source_processor_exception_audits BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_processor_exception_audits_replace_immutable BEFORE INSERT ON source_processor_exception_audits WHEN EXISTS(SELECT 1 FROM source_processor_exception_audits WHERE exception_id=NEW.exception_id) BEGIN SELECT RAISE(ABORT,'source_processor_evidence_immutable'); END;
CREATE TRIGGER source_poll_recovery_previews_update_immutable BEFORE UPDATE ON source_poll_recovery_previews BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER source_poll_recovery_previews_delete_immutable BEFORE DELETE ON source_poll_recovery_previews BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER source_poll_recovery_previews_replace_immutable BEFORE INSERT ON source_poll_recovery_previews WHEN EXISTS(SELECT 1 FROM source_poll_recovery_previews WHERE preview_id=NEW.preview_id) BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER source_poll_recovery_audits_update_immutable BEFORE UPDATE ON source_poll_recovery_audits BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER source_poll_recovery_audits_delete_immutable BEFORE DELETE ON source_poll_recovery_audits BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER source_poll_recovery_audits_replace_immutable BEFORE INSERT ON source_poll_recovery_audits WHEN EXISTS(SELECT 1 FROM source_poll_recovery_audits WHERE operation_id=NEW.operation_id) BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER source_poll_marker_recovery_audits_update_immutable BEFORE UPDATE ON source_poll_marker_recovery_audits BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER source_poll_marker_recovery_audits_delete_immutable BEFORE DELETE ON source_poll_marker_recovery_audits BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER source_poll_marker_recovery_audits_replace_immutable BEFORE INSERT ON source_poll_marker_recovery_audits WHEN EXISTS(SELECT 1 FROM source_poll_marker_recovery_audits WHERE operation_id=NEW.operation_id OR preview_id=NEW.preview_id OR request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER source_poll_recovery_audits_unique_evidence_immutable BEFORE INSERT ON source_poll_recovery_audits WHEN EXISTS(SELECT 1 FROM source_poll_recovery_audits WHERE operation_id=NEW.operation_id OR preview_id=NEW.preview_id OR request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'source_poll_recovery_evidence_immutable'); END;
CREATE TRIGGER forecast_runtime_versions_validate BEFORE INSERT ON forecast_runtime_versions BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM forecast_candidates c WHERE c.candidate_id=NEW.candidate_id
    AND c.payload_hash=NEW.payload_hash AND json_valid(c.payload_json)
    AND json_extract(c.payload_json,'$.candidateId')=NEW.candidate_id
    AND json_extract(c.payload_json,'$.forecastId')=c.forecast_id
    AND json_extract(c.payload_json,'$.rulesVersion')=NEW.rules_version
    AND json_extract(c.payload_json,'$.payloadVersion')=NEW.payload_version
    AND json_extract(c.payload_json,'$.certifiedSnapshot.version')=NEW.snapshot_version
    AND length(CAST(c.payload_json AS BLOB))=NEW.payload_bytes
    AND c.source_status IN ('crosschecked','x_unavailable')
    AND c.state NOT IN ('conflict','rejected','superseded')
  ) THEN RAISE(ABORT,'runtime_version_invalid') END;
END;
CREATE TRIGGER forecast_runtime_versions_update BEFORE UPDATE ON forecast_runtime_versions BEGIN SELECT RAISE(ABORT,'runtime_version_immutable'); END;
CREATE TRIGGER forecast_runtime_versions_delete BEFORE DELETE ON forecast_runtime_versions BEGIN SELECT RAISE(ABORT,'runtime_version_immutable'); END;
CREATE TRIGGER forecast_runtime_versions_replace BEFORE INSERT ON forecast_runtime_versions
WHEN EXISTS(SELECT 1 FROM forecast_runtime_versions WHERE candidate_id=NEW.candidate_id OR payload_hash=NEW.payload_hash)
BEGIN SELECT RAISE(ABORT,'runtime_version_immutable'); END;
CREATE TRIGGER forecast_runtime_candidate_update BEFORE UPDATE ON forecast_candidates
WHEN EXISTS(SELECT 1 FROM forecast_runtime_versions WHERE candidate_id=OLD.candidate_id)
AND (NEW.candidate_id IS NOT OLD.candidate_id OR NEW.forecast_id IS NOT OLD.forecast_id
  OR NEW.schedule_event_id IS NOT OLD.schedule_event_id OR NEW.game_day IS NOT OLD.game_day
  OR NEW.revision IS NOT OLD.revision OR NEW.source_status IS NOT OLD.source_status
  OR NEW.payload_json IS NOT OLD.payload_json OR NEW.payload_hash IS NOT OLD.payload_hash
  OR NEW.created_at IS NOT OLD.created_at)
BEGIN SELECT RAISE(ABORT,'runtime_candidate_sealed'); END;
CREATE TRIGGER forecast_runtime_candidate_delete BEFORE DELETE ON forecast_candidates
WHEN EXISTS(SELECT 1 FROM forecast_runtime_versions WHERE candidate_id=OLD.candidate_id)
BEGIN SELECT RAISE(ABORT,'runtime_candidate_sealed'); END;
CREATE TRIGGER forecast_runtime_candidate_replace BEFORE INSERT ON forecast_candidates
WHEN EXISTS(
  SELECT 1 FROM forecast_candidates c JOIN forecast_runtime_versions v ON v.candidate_id=c.candidate_id
  WHERE c.candidate_id=NEW.candidate_id OR c.payload_hash=NEW.payload_hash OR (c.game_day=NEW.game_day AND c.revision=NEW.revision)
)
BEGIN SELECT RAISE(ABORT,'runtime_candidate_sealed'); END;
CREATE TRIGGER forecast_runtime_review_validate BEFORE INSERT ON forecast_runtime_reviews BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM forecast_runtime_active a
    WHERE a.environment=NEW.environment AND a.sequence=NEW.expected_sequence AND a.candidate_id IS NEW.previous_candidate_id)
    THEN RAISE(ABORT,'runtime_review_stale') END;
  SELECT CASE WHEN NEW.action!='off' AND NOT EXISTS(SELECT 1 FROM forecast_runtime_versions
    WHERE candidate_id=NEW.candidate_id AND payload_hash=NEW.payload_hash)
    THEN RAISE(ABORT,'runtime_review_hash') END;
  SELECT CASE WHEN NEW.action='rollback' AND NOT EXISTS(SELECT 1 FROM forecast_runtime_approvals
    WHERE candidate_id=NEW.candidate_id AND environment=NEW.environment)
    THEN RAISE(ABORT,'runtime_rollback_unapproved') END;
END;
CREATE TRIGGER forecast_runtime_approval_validate BEFORE INSERT ON forecast_runtime_approvals BEGIN
  -- A seal protects content, not eligibility. The collector may supersede an
  -- unapproved sealed artifact after its review was delivered. Check the current
  -- workflow state in the approval transaction; rollback uses an existing approval.
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM forecast_candidates
    WHERE candidate_id=NEW.candidate_id AND state IN ('crosschecked','x_unavailable','proposed'))
    THEN RAISE(ABORT,'runtime_approval_ineligible') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM forecast_runtime_commands c
    JOIN forecast_runtime_reviews r ON r.review_id=c.review_id
    JOIN forecast_runtime_versions v ON v.candidate_id=r.candidate_id
    WHERE c.interaction_id=NEW.interaction_id AND c.actor_id=NEW.actor_id AND c.state='pending'
      AND r.action='approve' AND r.environment=NEW.environment AND r.candidate_id=NEW.candidate_id
      AND r.payload_hash=NEW.payload_hash AND v.payload_hash=NEW.payload_hash AND r.expires_at>NEW.approved_at)
    THEN RAISE(ABORT,'runtime_approval_invalid') END;
END;
CREATE TRIGGER forecast_runtime_activation_validate BEFORE INSERT ON forecast_runtime_activation_history BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM forecast_runtime_commands c
    JOIN forecast_runtime_reviews r ON r.review_id=c.review_id
    JOIN forecast_runtime_active a ON a.singleton=1
    WHERE c.interaction_id=NEW.operation_id AND c.review_id=NEW.review_id AND c.actor_id=NEW.actor_id AND c.state='pending'
      AND r.environment=NEW.environment AND a.environment=NEW.environment AND r.action=NEW.action
      AND r.expires_at>NEW.applied_at AND r.created_at<=NEW.applied_at
      AND r.candidate_id IS NEW.candidate_id AND r.previous_candidate_id IS NEW.previous_candidate_id
      AND a.candidate_id IS NEW.previous_candidate_id AND r.expected_sequence=a.sequence AND NEW.sequence=a.sequence+1)
    THEN RAISE(ABORT,'runtime_activation_stale') END;
  SELECT CASE WHEN NEW.action!='off' AND NOT EXISTS(SELECT 1 FROM forecast_runtime_approvals p
    JOIN forecast_runtime_reviews r ON r.review_id=NEW.review_id
    WHERE p.candidate_id=NEW.candidate_id AND p.environment=NEW.environment AND p.payload_hash=r.payload_hash
      AND (NEW.action='rollback' OR p.interaction_id=NEW.operation_id))
    THEN RAISE(ABORT,'runtime_activation_unapproved') END;
  SELECT CASE WHEN NOT (
    json_extract(NEW.signed_pointer_json,'$.statement.domain') IS 'nikke.forecast.pointer.v1'
    AND json_extract(NEW.signed_pointer_json,'$.statement.environment') IS NEW.environment
    AND json_extract(NEW.signed_pointer_json,'$.statement.sequence') IS NEW.sequence
    AND json_extract(NEW.signed_pointer_json,'$.statement.candidateId') IS NEW.candidate_id
    AND json_extract(NEW.signed_pointer_json,'$.statement.contentHash') IS (SELECT payload_hash FROM forecast_runtime_reviews WHERE review_id=NEW.review_id)
    AND json_extract(NEW.signed_pointer_json,'$.statement.mode') IS CASE WHEN NEW.action='off' THEN 'off' ELSE 'active' END
    AND json_extract(NEW.signed_pointer_json,'$.statement.operationId') IS NEW.operation_id
    AND json_extract(NEW.signed_pointer_json,'$.statement.issuedAt') IS NEW.applied_at
    AND length(COALESCE(json_extract(NEW.signed_pointer_json,'$.statement.keyId'),''))>0
    AND length(COALESCE(json_extract(NEW.signed_pointer_json,'$.signature'),''))=88
  ) THEN RAISE(ABORT,'runtime_pointer_invalid') END;
END;
CREATE TRIGGER forecast_runtime_activation_apply AFTER INSERT ON forecast_runtime_activation_history BEGIN
  UPDATE forecast_runtime_active SET sequence=NEW.sequence,candidate_id=NEW.candidate_id,
    operation_id=NEW.operation_id,signed_pointer_json=NEW.signed_pointer_json
    WHERE singleton=1 AND sequence=NEW.sequence-1 AND environment=NEW.environment;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'runtime_pointer_not_changed') END;
  UPDATE forecast_runtime_commands SET state='applied',result_sequence=NEW.sequence,error_code=NULL,updated_at=NEW.applied_at
    WHERE interaction_id=NEW.operation_id AND state='pending';
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'runtime_command_not_changed') END;
  INSERT INTO forecast_runtime_outbox(outbox_id,environment,kind,review_id,operation_id,next_attempt_at)
    VALUES('result:'||NEW.operation_id,NEW.environment,'result',NEW.review_id,NEW.operation_id,NEW.applied_at);
END;
CREATE TRIGGER forecast_runtime_active_insert BEFORE INSERT ON forecast_runtime_active
WHEN NEW.sequence!=0 OR EXISTS(SELECT 1 FROM forecast_runtime_active)
BEGIN SELECT RAISE(ABORT,'runtime_pointer_direct_write'); END;
CREATE TRIGGER forecast_runtime_active_update BEFORE UPDATE ON forecast_runtime_active
WHEN NEW.singleton IS NOT OLD.singleton OR NEW.environment IS NOT OLD.environment OR NEW.sequence!=OLD.sequence+1
  OR NOT EXISTS(SELECT 1 FROM forecast_runtime_activation_history h WHERE h.operation_id=NEW.operation_id
    AND h.sequence=NEW.sequence AND h.environment=NEW.environment AND h.previous_candidate_id IS OLD.candidate_id
    AND h.candidate_id IS NEW.candidate_id AND h.signed_pointer_json=NEW.signed_pointer_json)
BEGIN SELECT RAISE(ABORT,'runtime_pointer_direct_write'); END;
CREATE TRIGGER forecast_runtime_active_delete BEFORE DELETE ON forecast_runtime_active BEGIN SELECT RAISE(ABORT,'runtime_pointer_direct_write'); END;
CREATE TRIGGER forecast_runtime_reviews_update BEFORE UPDATE ON forecast_runtime_reviews BEGIN SELECT RAISE(ABORT,'runtime_review_immutable'); END;
CREATE TRIGGER forecast_runtime_reviews_delete BEFORE DELETE ON forecast_runtime_reviews BEGIN SELECT RAISE(ABORT,'runtime_review_immutable'); END;
CREATE TRIGGER forecast_runtime_reviews_replace BEFORE INSERT ON forecast_runtime_reviews
WHEN EXISTS(SELECT 1 FROM forecast_runtime_reviews WHERE review_id=NEW.review_id OR review_key=NEW.review_key)
BEGIN SELECT RAISE(ABORT,'runtime_review_immutable'); END;
CREATE TRIGGER forecast_runtime_approvals_update BEFORE UPDATE ON forecast_runtime_approvals BEGIN SELECT RAISE(ABORT,'runtime_approval_immutable'); END;
CREATE TRIGGER forecast_runtime_approvals_delete BEFORE DELETE ON forecast_runtime_approvals BEGIN SELECT RAISE(ABORT,'runtime_approval_immutable'); END;
CREATE TRIGGER forecast_runtime_approvals_replace BEFORE INSERT ON forecast_runtime_approvals
WHEN EXISTS(SELECT 1 FROM forecast_runtime_approvals WHERE candidate_id=NEW.candidate_id OR interaction_id=NEW.interaction_id)
BEGIN SELECT RAISE(ABORT,'runtime_approval_immutable'); END;
CREATE TRIGGER forecast_runtime_history_update BEFORE UPDATE ON forecast_runtime_activation_history BEGIN SELECT RAISE(ABORT,'runtime_history_immutable'); END;
CREATE TRIGGER forecast_runtime_history_delete BEFORE DELETE ON forecast_runtime_activation_history BEGIN SELECT RAISE(ABORT,'runtime_history_immutable'); END;
CREATE TRIGGER forecast_runtime_history_replace BEFORE INSERT ON forecast_runtime_activation_history
WHEN EXISTS(SELECT 1 FROM forecast_runtime_activation_history WHERE operation_id=NEW.operation_id OR review_id=NEW.review_id OR sequence=NEW.sequence)
BEGIN SELECT RAISE(ABORT,'runtime_history_immutable'); END;
CREATE TRIGGER forecast_runtime_commands_identity BEFORE UPDATE ON forecast_runtime_commands
WHEN OLD.state='applied' OR NEW.interaction_id IS NOT OLD.interaction_id OR NEW.review_id IS NOT OLD.review_id
  OR NEW.request_hash IS NOT OLD.request_hash OR NEW.actor_id IS NOT OLD.actor_id OR NEW.created_at IS NOT OLD.created_at
  OR (NEW.state='applied' AND NOT EXISTS(SELECT 1 FROM forecast_runtime_activation_history WHERE operation_id=NEW.interaction_id AND sequence=NEW.result_sequence))
BEGIN SELECT RAISE(ABORT,'runtime_command_immutable'); END;
CREATE TRIGGER forecast_runtime_commands_delete BEFORE DELETE ON forecast_runtime_commands BEGIN SELECT RAISE(ABORT,'runtime_command_immutable'); END;
CREATE TRIGGER forecast_runtime_commands_replace BEFORE INSERT ON forecast_runtime_commands
WHEN EXISTS(SELECT 1 FROM forecast_runtime_commands WHERE interaction_id=NEW.interaction_id)
BEGIN SELECT RAISE(ABORT,'runtime_command_immutable'); END;
CREATE TRIGGER forecast_runtime_outbox_identity BEFORE UPDATE ON forecast_runtime_outbox
WHEN OLD.state='sent' OR NEW.outbox_id IS NOT OLD.outbox_id OR NEW.environment IS NOT OLD.environment
  OR NEW.kind IS NOT OLD.kind OR NEW.review_id IS NOT OLD.review_id OR NEW.operation_id IS NOT OLD.operation_id
BEGIN SELECT RAISE(ABORT,'runtime_outbox_immutable'); END;
CREATE TRIGGER forecast_runtime_outbox_delete BEFORE DELETE ON forecast_runtime_outbox BEGIN SELECT RAISE(ABORT,'runtime_outbox_immutable'); END;
CREATE TRIGGER forecast_runtime_outbox_replace BEFORE INSERT ON forecast_runtime_outbox
WHEN EXISTS(SELECT 1 FROM forecast_runtime_outbox WHERE outbox_id=NEW.outbox_id OR operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'runtime_outbox_immutable'); END;
CREATE TRIGGER forecast_runtime_approved_candidate_update BEFORE UPDATE ON forecast_candidates
WHEN EXISTS(SELECT 1 FROM forecast_runtime_approvals WHERE candidate_id=OLD.candidate_id)
BEGIN SELECT RAISE(ABORT,'runtime_approved_candidate_immutable'); END;
CREATE TRIGGER forecast_runtime_approved_source_update BEFORE UPDATE ON candidate_sources
WHEN EXISTS(SELECT 1 FROM forecast_runtime_approvals WHERE candidate_id=OLD.candidate_id OR candidate_id=NEW.candidate_id)
BEGIN SELECT RAISE(ABORT,'runtime_approved_source_immutable'); END;
CREATE TRIGGER forecast_runtime_approved_source_delete BEFORE DELETE ON candidate_sources
WHEN EXISTS(SELECT 1 FROM forecast_runtime_approvals WHERE candidate_id=OLD.candidate_id)
BEGIN SELECT RAISE(ABORT,'runtime_approved_source_immutable'); END;
CREATE TRIGGER forecast_runtime_approved_source_insert BEFORE INSERT ON candidate_sources
WHEN EXISTS(SELECT 1 FROM forecast_runtime_approvals WHERE candidate_id=NEW.candidate_id)
BEGIN SELECT RAISE(ABORT,'runtime_approved_source_immutable'); END;
CREATE TRIGGER runtime_ingestion_commit_fence
BEFORE INSERT ON runtime_ingestion_commits BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM runtime_ingestion_commits WHERE run_token=NEW.run_token
  ) THEN RAISE(ABORT,'runtime_ingestion_evidence_immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM runtime_ingestion_runs
    WHERE token=NEW.run_token AND status='running'
      AND lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')
  ) THEN RAISE(ABORT,'runtime_ingestion_lease_expired') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.queue_snapshot) AS s
    WHERE NOT EXISTS (
      SELECT 1 FROM source_queue q
      WHERE q.source=json_extract(s.value,'$.source')
        AND q.item_id=json_extract(s.value,'$.item_id')
        AND q.url=json_extract(s.value,'$.url')
        AND q.title=json_extract(s.value,'$.title')
        AND q.published_at=json_extract(s.value,'$.published_at')
        AND q.official=json_extract(s.value,'$.official')
        AND q.status=json_extract(s.value,'$.status')
        AND q.attempts=json_extract(s.value,'$.attempts')
        AND q.review_generation=json_extract(s.value,'$.review_generation')
    )
  ) THEN RAISE(ABORT,'runtime_ingestion_source_conflict') END;
END;
CREATE TRIGGER runtime_ingestion_commits_immutable_update
BEFORE UPDATE ON runtime_ingestion_commits BEGIN SELECT RAISE(ABORT,'runtime_ingestion_evidence_immutable'); END;
CREATE TRIGGER runtime_ingestion_commits_immutable_delete
BEFORE DELETE ON runtime_ingestion_commits BEGIN SELECT RAISE(ABORT,'runtime_ingestion_evidence_immutable'); END;
CREATE TRIGGER runtime_notice_request_identity_update
BEFORE UPDATE ON runtime_notice_requests
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.run_token IS NOT OLD.run_token
  OR NEW.utc_day IS NOT OLD.utc_day OR NEW.source IS NOT OLD.source
  OR NEW.item_id IS NOT OLD.item_id OR NEW.reserved_at IS NOT OLD.reserved_at
BEGIN SELECT RAISE(ABORT,'runtime_notice_budget_immutable'); END;
CREATE TRIGGER runtime_notice_request_delete
BEFORE DELETE ON runtime_notice_requests BEGIN SELECT RAISE(ABORT,'runtime_notice_budget_immutable'); END;
CREATE TRIGGER runtime_notice_request_replace
BEFORE INSERT ON runtime_notice_requests
WHEN EXISTS(SELECT 1 FROM runtime_notice_requests WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'runtime_notice_budget_immutable'); END;
DROP TABLE "backup27_source_watermarks";
DROP TABLE "backup27_source_items";
DROP TABLE "backup27_source_poll_state";
DROP TABLE "backup27_source_queue";
DROP TABLE "backup27_source_manual_reviews";
DROP TABLE "backup27_source_collection_health";
DROP TABLE "backup27_source_processor_state";
DROP TABLE "backup27_source_processor_runs";
DROP TABLE "backup27_source_poll_recovery_previews";
DROP TABLE "backup27_source_poll_recovery_audits";
DROP TABLE "backup27_source_poll_marker_recovery_audits";
DROP TABLE "backup27_schedule_events";
DROP TABLE "backup27_forecast_candidates";
DROP TABLE "backup27_candidate_sources";
DROP TABLE "backup27_source_processing_claims";
DROP TABLE "backup27_forecast_candidate_semantics";
DROP TABLE "backup27_source_manual_resolution_evidence";
DROP TABLE "backup27_source_manual_review_bindings";
DROP TABLE "backup27_schedule_event_source_revisions";
DROP TABLE "backup27_source_legacy_event_baselines";
DROP TABLE "backup27_source_metadata_observations";
DROP TABLE "backup27_source_poll_scan_status";
DROP TABLE "backup27_source_processor_item_bindings";
DROP TABLE "backup27_source_processor_incidents";
DROP TABLE "backup27_source_processor_incident_heads";
DROP TABLE "backup27_source_processor_detail_settlements";
DROP TABLE "backup27_source_processor_recovery_receipts";
DROP TABLE "backup27_source_processor_control_reservations";
DROP TABLE "backup27_source_processor_control_results";
DROP TABLE "backup27_source_processor_recovery_probes";
DROP TABLE "backup27_source_processor_item_exceptions";
DROP TABLE "backup27_source_processor_exception_resolutions";
DROP TABLE "backup27_source_processor_proof_invalidations";
DROP TABLE "backup27_source_processor_target_reservations";
DROP TABLE "backup27_source_processor_exception_audits";
DROP TABLE "backup27_forecast_runtime_admissions";
DROP TABLE "backup27_forecast_runtime_versions";
DROP TABLE "backup27_forecast_runtime_reviews";
DROP TABLE "backup27_forecast_runtime_commands";
DROP TABLE "backup27_forecast_runtime_approvals";
DROP TABLE "backup27_forecast_runtime_active";
DROP TABLE "backup27_forecast_runtime_activation_history";
DROP TABLE "backup27_forecast_runtime_outbox";
DROP TABLE "backup27_runtime_ingestion_runs";
DROP TABLE "backup27_runtime_notice_requests";
DROP TABLE "backup27_runtime_ingestion_items";
DROP TABLE "backup27_runtime_ingestion_commits";

ALTER TABLE schedule_events ADD COLUMN segment_json TEXT CHECK(segment_json IS NULL OR json_valid(segment_json));
CREATE TABLE forecast_grants (
  grant_id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('naver-board-48','naver-board-56','naver-board-11')),
  origin_item_id TEXT NOT NULL,
  grant_game_date TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source,origin_item_id,grant_game_date,seq)
);
CREATE TABLE forecast_grant_revisions (
  grant_id TEXT NOT NULL REFERENCES forecast_grants(grant_id),
  content_hash TEXT NOT NULL,
  kits_json TEXT NOT NULL CHECK(json_valid(kits_json)),
  claim_until TEXT,
  claim_window_assumed INTEGER NOT NULL CHECK(claim_window_assumed IN (0,1)),
  observed_at TEXT NOT NULL,
  PRIMARY KEY(grant_id,content_hash)
);
CREATE TABLE forecast_grant_restatements (
  source TEXT NOT NULL CHECK(source IN ('naver-board-48','naver-board-56','naver-board-11')),
  item_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES forecast_grants(grant_id),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(source,item_id,content_hash,grant_id)
);

CREATE TRIGGER forecast_grants_update_immutable BEFORE UPDATE ON forecast_grants BEGIN SELECT RAISE(ABORT,'forecast_grant_immutable'); END;
CREATE TRIGGER forecast_grants_delete_immutable BEFORE DELETE ON forecast_grants BEGIN SELECT RAISE(ABORT,'forecast_grant_immutable'); END;
CREATE TRIGGER forecast_grants_replace_immutable BEFORE INSERT ON forecast_grants WHEN EXISTS(SELECT 1 FROM forecast_grants WHERE grant_id=NEW.grant_id OR (source=NEW.source AND origin_item_id=NEW.origin_item_id AND grant_game_date=NEW.grant_game_date AND seq=NEW.seq)) BEGIN SELECT RAISE(ABORT,'forecast_grant_immutable'); END;
CREATE TRIGGER forecast_grant_revisions_update_immutable BEFORE UPDATE ON forecast_grant_revisions BEGIN SELECT RAISE(ABORT,'forecast_grant_immutable'); END;
CREATE TRIGGER forecast_grant_revisions_delete_immutable BEFORE DELETE ON forecast_grant_revisions BEGIN SELECT RAISE(ABORT,'forecast_grant_immutable'); END;
CREATE TRIGGER forecast_grant_revisions_replace_immutable BEFORE INSERT ON forecast_grant_revisions WHEN EXISTS(SELECT 1 FROM forecast_grant_revisions WHERE grant_id=NEW.grant_id AND content_hash=NEW.content_hash) BEGIN SELECT RAISE(ABORT,'forecast_grant_immutable'); END;
CREATE TRIGGER forecast_grant_restatements_update_immutable BEFORE UPDATE ON forecast_grant_restatements BEGIN SELECT RAISE(ABORT,'forecast_grant_immutable'); END;
CREATE TRIGGER forecast_grant_restatements_delete_immutable BEFORE DELETE ON forecast_grant_restatements BEGIN SELECT RAISE(ABORT,'forecast_grant_immutable'); END;
CREATE TRIGGER forecast_grant_restatements_replace_immutable BEFORE INSERT ON forecast_grant_restatements WHEN EXISTS(SELECT 1 FROM forecast_grant_restatements WHERE source=NEW.source AND item_id=NEW.item_id AND content_hash=NEW.content_hash AND grant_id=NEW.grant_id) BEGIN SELECT RAISE(ABORT,'forecast_grant_immutable'); END;
INSERT INTO schema_migrations(version,applied_at) VALUES(27,CURRENT_TIMESTAMP);
