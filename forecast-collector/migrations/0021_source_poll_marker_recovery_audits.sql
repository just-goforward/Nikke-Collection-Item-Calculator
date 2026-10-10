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
