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
