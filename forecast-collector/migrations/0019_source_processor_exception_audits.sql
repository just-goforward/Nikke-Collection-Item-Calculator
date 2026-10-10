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
