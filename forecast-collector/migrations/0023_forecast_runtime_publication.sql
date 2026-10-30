-- Separate authority from legacy PR approvals. No data is activated by migration.
CREATE TABLE IF NOT EXISTS forecast_runtime_reviews (
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
CREATE INDEX IF NOT EXISTS forecast_runtime_reviews_candidate_idx ON forecast_runtime_reviews(candidate_id,expected_sequence,expires_at);
CREATE TABLE IF NOT EXISTS forecast_runtime_commands (
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
CREATE TABLE IF NOT EXISTS forecast_runtime_approvals (
  candidate_id TEXT PRIMARY KEY NOT NULL REFERENCES forecast_runtime_versions(candidate_id) ON DELETE RESTRICT,
  interaction_id TEXT NOT NULL UNIQUE REFERENCES forecast_runtime_commands(interaction_id) ON DELETE RESTRICT,
  environment TEXT NOT NULL CHECK(environment IN ('staging','production')),
  payload_hash TEXT NOT NULL,
  key_id TEXT NOT NULL,
  artifact_signature TEXT NOT NULL CHECK(length(artifact_signature)=88),
  actor_id TEXT NOT NULL,
  approved_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS forecast_runtime_active (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  environment TEXT NOT NULL CHECK(environment IN ('staging','production')),
  sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<=9007199254740991),
  candidate_id TEXT REFERENCES forecast_runtime_approvals(candidate_id) ON DELETE RESTRICT,
  operation_id TEXT,
  signed_pointer_json TEXT CHECK(signed_pointer_json IS NULL OR json_valid(signed_pointer_json)),
  CHECK((sequence=0 AND candidate_id IS NULL AND operation_id IS NULL AND signed_pointer_json IS NULL)
    OR (sequence>0 AND operation_id IS NOT NULL AND signed_pointer_json IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS forecast_runtime_activation_history (
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
CREATE TABLE IF NOT EXISTS forecast_runtime_outbox (
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
CREATE INDEX IF NOT EXISTS forecast_runtime_outbox_due_idx ON forecast_runtime_outbox(environment,state,next_attempt_at);

CREATE TRIGGER IF NOT EXISTS forecast_runtime_review_validate BEFORE INSERT ON forecast_runtime_reviews BEGIN
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
CREATE TRIGGER IF NOT EXISTS forecast_runtime_approval_validate BEFORE INSERT ON forecast_runtime_approvals BEGIN
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
CREATE TRIGGER IF NOT EXISTS forecast_runtime_activation_validate BEFORE INSERT ON forecast_runtime_activation_history BEGIN
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
CREATE TRIGGER IF NOT EXISTS forecast_runtime_activation_apply AFTER INSERT ON forecast_runtime_activation_history BEGIN
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
CREATE TRIGGER IF NOT EXISTS forecast_runtime_active_insert BEFORE INSERT ON forecast_runtime_active
WHEN NEW.sequence!=0 OR EXISTS(SELECT 1 FROM forecast_runtime_active)
BEGIN SELECT RAISE(ABORT,'runtime_pointer_direct_write'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_active_update BEFORE UPDATE ON forecast_runtime_active
WHEN NEW.singleton IS NOT OLD.singleton OR NEW.environment IS NOT OLD.environment OR NEW.sequence!=OLD.sequence+1
  OR NOT EXISTS(SELECT 1 FROM forecast_runtime_activation_history h WHERE h.operation_id=NEW.operation_id
    AND h.sequence=NEW.sequence AND h.environment=NEW.environment AND h.previous_candidate_id IS OLD.candidate_id
    AND h.candidate_id IS NEW.candidate_id AND h.signed_pointer_json=NEW.signed_pointer_json)
BEGIN SELECT RAISE(ABORT,'runtime_pointer_direct_write'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_active_delete BEFORE DELETE ON forecast_runtime_active BEGIN SELECT RAISE(ABORT,'runtime_pointer_direct_write'); END;

CREATE TRIGGER IF NOT EXISTS forecast_runtime_reviews_update BEFORE UPDATE ON forecast_runtime_reviews BEGIN SELECT RAISE(ABORT,'runtime_review_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_reviews_delete BEFORE DELETE ON forecast_runtime_reviews BEGIN SELECT RAISE(ABORT,'runtime_review_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_reviews_replace BEFORE INSERT ON forecast_runtime_reviews
WHEN EXISTS(SELECT 1 FROM forecast_runtime_reviews WHERE review_id=NEW.review_id OR review_key=NEW.review_key)
BEGIN SELECT RAISE(ABORT,'runtime_review_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_approvals_update BEFORE UPDATE ON forecast_runtime_approvals BEGIN SELECT RAISE(ABORT,'runtime_approval_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_approvals_delete BEFORE DELETE ON forecast_runtime_approvals BEGIN SELECT RAISE(ABORT,'runtime_approval_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_approvals_replace BEFORE INSERT ON forecast_runtime_approvals
WHEN EXISTS(SELECT 1 FROM forecast_runtime_approvals WHERE candidate_id=NEW.candidate_id OR interaction_id=NEW.interaction_id)
BEGIN SELECT RAISE(ABORT,'runtime_approval_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_history_update BEFORE UPDATE ON forecast_runtime_activation_history BEGIN SELECT RAISE(ABORT,'runtime_history_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_history_delete BEFORE DELETE ON forecast_runtime_activation_history BEGIN SELECT RAISE(ABORT,'runtime_history_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_history_replace BEFORE INSERT ON forecast_runtime_activation_history
WHEN EXISTS(SELECT 1 FROM forecast_runtime_activation_history WHERE operation_id=NEW.operation_id OR review_id=NEW.review_id OR sequence=NEW.sequence)
BEGIN SELECT RAISE(ABORT,'runtime_history_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_commands_identity BEFORE UPDATE ON forecast_runtime_commands
WHEN OLD.state='applied' OR NEW.interaction_id IS NOT OLD.interaction_id OR NEW.review_id IS NOT OLD.review_id
  OR NEW.request_hash IS NOT OLD.request_hash OR NEW.actor_id IS NOT OLD.actor_id OR NEW.created_at IS NOT OLD.created_at
  OR (NEW.state='applied' AND NOT EXISTS(SELECT 1 FROM forecast_runtime_activation_history WHERE operation_id=NEW.interaction_id AND sequence=NEW.result_sequence))
BEGIN SELECT RAISE(ABORT,'runtime_command_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_commands_delete BEFORE DELETE ON forecast_runtime_commands BEGIN SELECT RAISE(ABORT,'runtime_command_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_commands_replace BEFORE INSERT ON forecast_runtime_commands
WHEN EXISTS(SELECT 1 FROM forecast_runtime_commands WHERE interaction_id=NEW.interaction_id)
BEGIN SELECT RAISE(ABORT,'runtime_command_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_outbox_identity BEFORE UPDATE ON forecast_runtime_outbox
WHEN OLD.state='sent' OR NEW.outbox_id IS NOT OLD.outbox_id OR NEW.environment IS NOT OLD.environment
  OR NEW.kind IS NOT OLD.kind OR NEW.review_id IS NOT OLD.review_id OR NEW.operation_id IS NOT OLD.operation_id
BEGIN SELECT RAISE(ABORT,'runtime_outbox_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_outbox_delete BEFORE DELETE ON forecast_runtime_outbox BEGIN SELECT RAISE(ABORT,'runtime_outbox_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_outbox_replace BEFORE INSERT ON forecast_runtime_outbox
WHEN EXISTS(SELECT 1 FROM forecast_runtime_outbox WHERE outbox_id=NEW.outbox_id OR operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'runtime_outbox_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_approved_candidate_update BEFORE UPDATE ON forecast_candidates
WHEN EXISTS(SELECT 1 FROM forecast_runtime_approvals WHERE candidate_id=OLD.candidate_id)
BEGIN SELECT RAISE(ABORT,'runtime_approved_candidate_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_approved_source_update BEFORE UPDATE ON candidate_sources
WHEN EXISTS(SELECT 1 FROM forecast_runtime_approvals WHERE candidate_id=OLD.candidate_id OR candidate_id=NEW.candidate_id)
BEGIN SELECT RAISE(ABORT,'runtime_approved_source_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_approved_source_delete BEFORE DELETE ON candidate_sources
WHEN EXISTS(SELECT 1 FROM forecast_runtime_approvals WHERE candidate_id=OLD.candidate_id)
BEGIN SELECT RAISE(ABORT,'runtime_approved_source_immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecast_runtime_approved_source_insert BEFORE INSERT ON candidate_sources
WHEN EXISTS(SELECT 1 FROM forecast_runtime_approvals WHERE candidate_id=NEW.candidate_id)
BEGIN SELECT RAISE(ABORT,'runtime_approved_source_immutable'); END;
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(23,CURRENT_TIMESTAMP);
