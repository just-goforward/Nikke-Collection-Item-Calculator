CREATE TABLE IF NOT EXISTS solver_runtime_aggregates (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  solver_version TEXT NOT NULL,
  solver_phase TEXT NOT NULL,
  solver_backend TEXT NOT NULL,
  fallback_from TEXT NOT NULL,
  fallback_reason TEXT NOT NULL,
  grade TEXT NOT NULL,
  level INTEGER NOT NULL,
  exp_bucket INTEGER NOT NULL,
  stock_bucket_blue TEXT NOT NULL,
  stock_bucket_purple TEXT NOT NULL,
  stock_bucket_yellow TEXT NOT NULL,
  node_count_bucket TEXT NOT NULL,
  attempted_node_count_bucket TEXT NOT NULL,
  solve_ms_bucket TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key,
    diagnostic_version,
    solver_version,
    solver_phase,
    solver_backend,
    fallback_from,
    fallback_reason,
    grade,
    level,
    exp_bucket,
    stock_bucket_blue,
    stock_bucket_purple,
    stock_bucket_yellow,
    node_count_bucket,
    attempted_node_count_bucket,
    solve_ms_bucket
  )
);

CREATE INDEX IF NOT EXISTS idx_solver_runtime_aggregates_backend
  ON solver_runtime_aggregates (solver_backend);
CREATE INDEX IF NOT EXISTS idx_solver_runtime_aggregates_fallback_context
  ON solver_runtime_aggregates (fallback_reason, grade, level);
