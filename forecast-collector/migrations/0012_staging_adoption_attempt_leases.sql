-- Selection consumes an attempt before any validator or external workflow work.
CREATE TABLE IF NOT EXISTS staging_adoption_attempt_leases (
  approval_id TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL CHECK(length(lease_token)=36),
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 8),
  state TEXT NOT NULL CHECK(state IN ('active','settled')),
  lease_until TEXT NOT NULL,
  outcome TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  FOREIGN KEY(approval_id) REFERENCES discord_staging_adoptions(approval_id)
);
CREATE INDEX IF NOT EXISTS staging_adoption_lease_expiry ON staging_adoption_attempt_leases(state,lease_until);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(12,CURRENT_TIMESTAMP);
