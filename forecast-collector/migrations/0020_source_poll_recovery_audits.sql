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
