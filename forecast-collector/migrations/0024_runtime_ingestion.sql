-- Runtime ingestion is isolated from GitHub processor recovery epochs.
-- Reservations count failed/interrupted requests too, and are never refunded.
CREATE TABLE IF NOT EXISTS runtime_ingestion_runs (
  token TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','expired')),
  started_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  candidate_id TEXT REFERENCES forecast_candidates(candidate_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_ingestion_one_running
  ON runtime_ingestion_runs(status) WHERE status='running';
CREATE INDEX IF NOT EXISTS runtime_ingestion_runs_started_at
  ON runtime_ingestion_runs(started_at DESC);
CREATE TABLE IF NOT EXISTS runtime_notice_requests (
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
CREATE INDEX IF NOT EXISTS runtime_notice_requests_day ON runtime_notice_requests(utc_day);
CREATE INDEX IF NOT EXISTS runtime_notice_requests_item ON runtime_notice_requests(source,item_id,reserved_at);
CREATE TABLE IF NOT EXISTS runtime_ingestion_items (
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  next_check_at TEXT NOT NULL,
  failures INTEGER NOT NULL CHECK(failures BETWEEN 0 AND 3),
  PRIMARY KEY(source,item_id),
  FOREIGN KEY(source,item_id) REFERENCES source_queue(source,item_id)
);
CREATE TABLE IF NOT EXISTS runtime_ingestion_commits (
  run_token TEXT PRIMARY KEY REFERENCES runtime_ingestion_runs(token),
  committed_at TEXT NOT NULL,
  queue_snapshot TEXT NOT NULL CHECK(json_valid(queue_snapshot))
);
CREATE TRIGGER IF NOT EXISTS runtime_ingestion_commit_fence
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
CREATE TRIGGER IF NOT EXISTS runtime_ingestion_commits_immutable_update
BEFORE UPDATE ON runtime_ingestion_commits BEGIN SELECT RAISE(ABORT,'runtime_ingestion_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS runtime_ingestion_commits_immutable_delete
BEFORE DELETE ON runtime_ingestion_commits BEGIN SELECT RAISE(ABORT,'runtime_ingestion_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS runtime_notice_request_identity_update
BEFORE UPDATE ON runtime_notice_requests
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.run_token IS NOT OLD.run_token
  OR NEW.utc_day IS NOT OLD.utc_day OR NEW.source IS NOT OLD.source
  OR NEW.item_id IS NOT OLD.item_id OR NEW.reserved_at IS NOT OLD.reserved_at
BEGIN SELECT RAISE(ABORT,'runtime_notice_budget_immutable'); END;
CREATE TRIGGER IF NOT EXISTS runtime_notice_request_delete
BEFORE DELETE ON runtime_notice_requests BEGIN SELECT RAISE(ABORT,'runtime_notice_budget_immutable'); END;
CREATE TRIGGER IF NOT EXISTS runtime_notice_request_replace
BEFORE INSERT ON runtime_notice_requests
WHEN EXISTS(SELECT 1 FROM runtime_notice_requests WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'runtime_notice_budget_immutable'); END;
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(24,CURRENT_TIMESTAMP);
