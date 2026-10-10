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
