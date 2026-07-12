CREATE TABLE IF NOT EXISTS solver_cache_aggregates (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  requested_backend TEXT NOT NULL,
  terminal_backend TEXT NOT NULL,
  execution_kind TEXT NOT NULL,
  grade TEXT NOT NULL,
  level INTEGER NOT NULL,
  exp_bucket INTEGER NOT NULL,
  stock_bucket_blue TEXT NOT NULL,
  stock_bucket_purple TEXT NOT NULL,
  stock_bucket_yellow TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key,
    diagnostic_version,
    requested_backend,
    terminal_backend,
    execution_kind,
    grade,
    level,
    exp_bucket,
    stock_bucket_blue,
    stock_bucket_purple,
    stock_bucket_yellow
  )
);

CREATE INDEX IF NOT EXISTS idx_solver_cache_aggregates_backend
  ON solver_cache_aggregates (requested_backend, execution_kind);
