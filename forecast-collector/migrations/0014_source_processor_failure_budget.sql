-- Durable source-processor attempts and recovery proofs. Create-only upgrade.
-- accepted source evidence and per-item decisions are never rewritten here.
CREATE TABLE IF NOT EXISTS source_processor_state (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch>=1),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','retry','held','verifying','verified')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 3),
  next_retry_at TEXT,
  active_token TEXT CHECK(active_token IS NULL OR length(active_token)=36),
  lease_until TEXT,
  last_error_code TEXT,
  failed_scope TEXT CHECK(failed_scope IS NULL OR failed_scope IN ('pipeline','metadata','daily','claim','detail','refresh')),
  failed_source TEXT CHECK(failed_source IS NULL OR failed_source IN ('naver-board-48','naver-board-56')),
  failed_item_id TEXT,
  failed_generation INTEGER CHECK(failed_generation IS NULL OR failed_generation>=0),
  updated_at TEXT NOT NULL,
  CHECK((active_token IS NULL)=(lease_until IS NULL))
);
CREATE TABLE IF NOT EXISTS source_processor_runs (
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
  failed_source TEXT CHECK(failed_source IS NULL OR failed_source IN ('naver-board-48','naver-board-56')),
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
CREATE INDEX IF NOT EXISTS idx_source_processor_runs_epoch ON source_processor_runs(epoch,started_at);
CREATE TABLE IF NOT EXISTS source_processor_item_bindings (
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
CREATE INDEX IF NOT EXISTS idx_source_processor_item_claim ON source_processor_item_bindings(item_claim_token,source,item_id);

INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(14,CURRENT_TIMESTAMP);
