-- Additive runtime admission. The existing JSON payload remains the only artifact body;
-- applications canonicalize parsed JSON for hashing/signing, without rewriting sealed bytes.
-- One bounded admission/review-attempt record per candidate; failures are retained,
-- not silently skipped or retried forever. No legacy candidate state is changed.
CREATE TABLE IF NOT EXISTS forecast_runtime_admissions (
  candidate_id TEXT PRIMARY KEY NOT NULL REFERENCES forecast_candidates(candidate_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('pending','running','ready','dead')),
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 5),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  error_code TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS forecast_runtime_versions (
  candidate_id TEXT PRIMARY KEY NOT NULL REFERENCES forecast_candidates(candidate_id) ON DELETE RESTRICT,
  payload_hash TEXT NOT NULL UNIQUE CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  rules_version TEXT NOT NULL CHECK(rules_version='schedule-kit-v3'),
  payload_version INTEGER NOT NULL CHECK(payload_version=4),
  snapshot_version TEXT NOT NULL CHECK(snapshot_version='certified-daily-v3'),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes>0),
  sealed_at INTEGER NOT NULL CHECK(sealed_at>0)
);
CREATE TRIGGER IF NOT EXISTS forecast_runtime_versions_validate BEFORE INSERT ON forecast_runtime_versions BEGIN
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
CREATE TRIGGER IF NOT EXISTS forecast_runtime_versions_update BEFORE UPDATE ON forecast_runtime_versions BEGIN SELECT RAISE(ABORT,'runtime_version_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_versions_delete BEFORE DELETE ON forecast_runtime_versions BEGIN SELECT RAISE(ABORT,'runtime_version_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_versions_replace BEFORE INSERT ON forecast_runtime_versions
WHEN EXISTS(SELECT 1 FROM forecast_runtime_versions WHERE candidate_id=NEW.candidate_id OR payload_hash=NEW.payload_hash)
BEGIN SELECT RAISE(ABORT,'runtime_version_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_candidate_update BEFORE UPDATE ON forecast_candidates
WHEN EXISTS(SELECT 1 FROM forecast_runtime_versions WHERE candidate_id=OLD.candidate_id)
AND (NEW.candidate_id IS NOT OLD.candidate_id OR NEW.forecast_id IS NOT OLD.forecast_id
  OR NEW.schedule_event_id IS NOT OLD.schedule_event_id OR NEW.game_day IS NOT OLD.game_day
  OR NEW.revision IS NOT OLD.revision OR NEW.source_status IS NOT OLD.source_status
  OR NEW.payload_json IS NOT OLD.payload_json OR NEW.payload_hash IS NOT OLD.payload_hash
  OR NEW.created_at IS NOT OLD.created_at)
BEGIN SELECT RAISE(ABORT,'runtime_candidate_sealed'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_candidate_delete BEFORE DELETE ON forecast_candidates
WHEN EXISTS(SELECT 1 FROM forecast_runtime_versions WHERE candidate_id=OLD.candidate_id)
BEGIN SELECT RAISE(ABORT,'runtime_candidate_sealed'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_candidate_replace BEFORE INSERT ON forecast_candidates
WHEN EXISTS(
  SELECT 1 FROM forecast_candidates c JOIN forecast_runtime_versions v ON v.candidate_id=c.candidate_id
  WHERE c.candidate_id=NEW.candidate_id OR c.payload_hash=NEW.payload_hash OR (c.game_day=NEW.game_day AND c.revision=NEW.revision)
)
BEGIN SELECT RAISE(ABORT,'runtime_candidate_sealed'); END;
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(22,CURRENT_TIMESTAMP);
