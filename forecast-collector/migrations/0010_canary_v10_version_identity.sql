PRAGMA foreign_keys = ON;

ALTER TABLE canary_runs ADD COLUMN collector_version_id TEXT;
ALTER TABLE canary_runs ADD COLUMN dispatcher_version_id TEXT;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (10, CURRENT_TIMESTAMP);
