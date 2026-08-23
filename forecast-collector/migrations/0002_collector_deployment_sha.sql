ALTER TABLE collector_runs
ADD COLUMN deployment_sha TEXT NOT NULL DEFAULT 'legacy';

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (2, CURRENT_TIMESTAMP);
