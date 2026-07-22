CREATE TABLE IF NOT EXISTS runtime_invariant_aggregates (
  date_key TEXT NOT NULL,
  invariant_version INTEGER NOT NULL,
  invariant_code TEXT NOT NULL,
  component TEXT NOT NULL,
  lane TEXT NOT NULL,
  device_type TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key, invariant_version, invariant_code, component, lane, device_type
  )
);

CREATE INDEX IF NOT EXISTS idx_runtime_invariant_aggregates_code
  ON runtime_invariant_aggregates (invariant_code, component, lane);
