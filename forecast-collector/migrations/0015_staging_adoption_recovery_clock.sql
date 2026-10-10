-- Create-only adoption recovery and approved-age clock storage.
-- Legacy nonhealthy state starts a pause only at this migration, as prior
-- continuous hold intervals cannot be inferred from lifetime counters.
CREATE TABLE IF NOT EXISTS staging_adoption_recovery_control (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch>=1),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','held','verified')),
  failure_generation INTEGER NOT NULL DEFAULT 0 CHECK(failure_generation>=0),
  error_code TEXT,
  failed_stage TEXT NOT NULL DEFAULT 'unknown' CHECK(failed_stage IN ('selection','generation','delivery','unknown')),
  recovery_token TEXT CHECK(recovery_token IS NULL OR length(recovery_token)=36),
  recovery_lease_until TEXT,
  next_recovery_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK((recovery_token IS NULL)=(recovery_lease_until IS NULL))
);
CREATE TABLE IF NOT EXISTS staging_adoption_hold_episodes (
  epoch INTEGER PRIMARY KEY CHECK(epoch>=1),
  held_at TEXT NOT NULL,
  resumed_at TEXT,
  initial_error_code TEXT,
  last_error_code TEXT,
  failed_stage TEXT NOT NULL CHECK(failed_stage IN ('selection','generation','delivery','unknown')),
  legacy_history_unknown INTEGER NOT NULL DEFAULT 0 CHECK(legacy_history_unknown IN (0,1)),
  probe_attempts_at_hold INTEGER NOT NULL DEFAULT 0 CHECK(probe_attempts_at_hold BETWEEN 0 AND 8),
  probe_attempts_at_resume INTEGER CHECK(probe_attempts_at_resume IS NULL OR probe_attempts_at_resume BETWEEN 0 AND 8),
  updated_at TEXT NOT NULL,
  CHECK(resumed_at IS NULL OR resumed_at>=held_at)
);
CREATE INDEX IF NOT EXISTS idx_adoption_hold_intervals ON staging_adoption_hold_episodes(resumed_at,held_at);
CREATE TABLE IF NOT EXISTS staging_adoption_recovery_runs (
  recovery_token TEXT PRIMARY KEY CHECK(length(recovery_token)=36),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  failure_generation INTEGER NOT NULL CHECK(failure_generation>=0),
  error_code TEXT NOT NULL,
  failed_stage TEXT NOT NULL CHECK(failed_stage IN ('selection','generation','delivery','unknown')),
  status TEXT NOT NULL CHECK(status IN ('active','verified','failed','expired','invalidated','resumed')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  started_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  verified_at TEXT,
  finished_at TEXT,
  evidence_json TEXT,
  resume_reason TEXT CHECK(resume_reason IS NULL OR length(resume_reason) BETWEEN 1 AND 500),
  approval_id TEXT,
  approval_binding_hash TEXT CHECK(approval_binding_hash IS NULL OR length(approval_binding_hash)=64),
  CHECK((approval_id IS NULL)=(approval_binding_hash IS NULL)),
  FOREIGN KEY(epoch) REFERENCES staging_adoption_hold_episodes(epoch)
);
CREATE INDEX IF NOT EXISTS idx_adoption_recovery_epoch ON staging_adoption_recovery_runs(epoch,started_at);
INSERT OR IGNORE INTO staging_adoption_recovery_control
  (singleton_id,epoch,state,failure_generation,error_code,failed_stage,updated_at)
  SELECT 1,1,'held',1,error_code,'unknown',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM staging_adoption_infrastructure_circuit WHERE state IN ('retry','blocked');
INSERT OR IGNORE INTO staging_adoption_hold_episodes
  (epoch,held_at,initial_error_code,last_error_code,failed_stage,legacy_history_unknown,probe_attempts_at_hold,updated_at)
  SELECT r.epoch,r.updated_at,r.error_code,r.error_code,'unknown',1,c.attempts,r.updated_at
  FROM staging_adoption_recovery_control r JOIN staging_adoption_infrastructure_circuit c ON c.singleton_id=r.singleton_id
  WHERE r.epoch=1 AND r.state='held' AND r.failure_generation=1 AND c.state IN ('retry','blocked');
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(15,CURRENT_TIMESTAMP);
