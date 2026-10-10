-- Durable, per-environment GitHub dispatch budget and explicit recovery audit.
CREATE TABLE IF NOT EXISTS dispatcher_retry_state (
  environment TEXT PRIMARY KEY CHECK(environment IN ('staging','production')),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch>=1),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','held','verified')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 3),
  held_at TEXT,
  proof_dispatch_id TEXT,
  proof_run_id INTEGER CHECK(proof_run_id IS NULL OR proof_run_id>0),
  proof_run_attempt INTEGER CHECK(proof_run_attempt IS NULL OR proof_run_attempt>0),
  proof_run_url TEXT,
  proof_reason TEXT CHECK(proof_reason IS NULL OR length(proof_reason) BETWEEN 1 AND 500),
  proof_conclusion TEXT CHECK(proof_conclusion IS NULL OR proof_conclusion IN ('success','failure','cancelled')),
  proof_kind TEXT CHECK(proof_kind IS NULL OR proof_kind IN ('callback','trusted_runner')),
  verified_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dispatcher_retry_attempts (
  dispatch_id TEXT PRIMARY KEY REFERENCES workflow_dispatches(dispatch_id),
  environment TEXT NOT NULL REFERENCES dispatcher_retry_state(environment),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  outcome TEXT NOT NULL DEFAULT 'reserved' CHECK(outcome IN ('reserved','accepted','failure')),
  settled_at TEXT,
  CHECK(environment IN ('staging','production'))
);
CREATE INDEX IF NOT EXISTS idx_dispatcher_retry_attempt_epoch ON dispatcher_retry_attempts(environment,epoch,outcome);
CREATE TABLE IF NOT EXISTS dispatcher_retry_proofs (
  environment TEXT NOT NULL REFERENCES dispatcher_retry_state(environment),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  dispatch_id TEXT NOT NULL REFERENCES workflow_dispatches(dispatch_id),
  run_id INTEGER NOT NULL CHECK(run_id>0),
  run_attempt INTEGER NOT NULL CHECK(run_attempt>0),
  run_url TEXT NOT NULL,
  conclusion TEXT NOT NULL CHECK(conclusion IN ('success','failure','cancelled')),
  kind TEXT NOT NULL CHECK(kind IN ('callback','trusted_runner')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  operation_at TEXT NOT NULL,
  operation_actor TEXT NOT NULL CHECK(operation_actor='dispatcher_github_app'),
  operation_name TEXT NOT NULL CHECK(operation_name='workflow_dispatch'),
  operation_http_status INTEGER NOT NULL CHECK(operation_http_status IN (200,204)),
  observed_at TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  resumed_at TEXT,
  resume_reason TEXT CHECK(resume_reason IS NULL OR length(resume_reason) BETWEEN 1 AND 500),
  PRIMARY KEY(environment,epoch),
  CHECK(environment IN ('staging','production')),
  CHECK((resumed_at IS NULL)=(resume_reason IS NULL))
);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(16,CURRENT_TIMESTAMP);
