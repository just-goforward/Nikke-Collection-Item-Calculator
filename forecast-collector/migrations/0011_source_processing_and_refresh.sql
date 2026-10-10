
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
