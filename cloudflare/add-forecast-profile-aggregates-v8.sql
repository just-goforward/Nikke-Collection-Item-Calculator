CREATE TABLE IF NOT EXISTS forecast_profile_aggregates (
  date_key TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
  forecast_profile_id TEXT NOT NULL,
  solver_backend TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key, event_kind, event_version, forecast_id, forecast_profile_id, solver_backend
  )
);

CREATE INDEX IF NOT EXISTS idx_forecast_profile_aggregates_profile
  ON forecast_profile_aggregates (forecast_id, forecast_profile_id, event_kind);
