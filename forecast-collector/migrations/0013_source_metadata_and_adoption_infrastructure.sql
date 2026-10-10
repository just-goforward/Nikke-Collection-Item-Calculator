-- Observation and circuit storage is create-only: retrying a partially applied
-- migration does not ALTER existing tables or rewrite accepted source evidence.
CREATE TABLE IF NOT EXISTS source_metadata_observations (
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  metadata_hash TEXT NOT NULL CHECK(length(metadata_hash)=64),
  review_generation INTEGER NOT NULL CHECK(review_generation>=0),
  invalid INTEGER NOT NULL CHECK(invalid IN (0,1)),
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(source,item_id),
  FOREIGN KEY(source,item_id) REFERENCES source_queue(source,item_id)
);

CREATE TABLE IF NOT EXISTS source_poll_scan_status (
  source TEXT PRIMARY KEY,
  scan_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(scan_uncertain IN (0,1)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(source) REFERENCES source_poll_state(source)
);

CREATE TABLE IF NOT EXISTS staging_adoption_infrastructure_circuit (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  state TEXT NOT NULL CHECK(state IN ('healthy','retry','blocked')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
  error_code TEXT,
  first_failed_at TEXT NOT NULL,
  next_probe_at TEXT,
  probe_token TEXT CHECK(probe_token IS NULL OR length(probe_token)=36),
  probe_lease_until TEXT,
  updated_at TEXT NOT NULL,
  CHECK((probe_token IS NULL)=(probe_lease_until IS NULL))
);

INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(13,CURRENT_TIMESTAMP);
