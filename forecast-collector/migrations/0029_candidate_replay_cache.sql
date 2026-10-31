CREATE TABLE runtime_candidate_cache (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  signature TEXT NOT NULL,
  run_token TEXT NOT NULL REFERENCES runtime_ingestion_runs(token),
  candidate_id TEXT NOT NULL REFERENCES forecast_candidates(candidate_id),
  payload_hash TEXT NOT NULL
);
INSERT INTO schema_migrations(version,applied_at) VALUES(29,CURRENT_TIMESTAMP);
