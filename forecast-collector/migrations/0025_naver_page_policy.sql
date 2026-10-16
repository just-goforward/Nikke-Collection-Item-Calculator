ALTER TABLE source_poll_state
  ADD COLUMN page_size INTEGER NOT NULL DEFAULT 10 CHECK (page_size IN (5, 10));

UPDATE forecast_ops_alerts
SET context_json = json_set(context_json, '$.pageSize', 10)
WHERE alert_key LIKE 'naver-boundary:%'
  AND json_extract(context_json, '$.pageSize') IS NULL;

INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(25,CURRENT_TIMESTAMP);
