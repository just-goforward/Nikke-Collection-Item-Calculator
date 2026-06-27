CREATE TABLE solver_runtime_aggregates_v6 (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  solver_version TEXT NOT NULL,
  solver_phase TEXT NOT NULL,
  solver_backend TEXT NOT NULL,
  fallback_from TEXT NOT NULL,
  fallback_reason TEXT NOT NULL,
  memory_strategy TEXT NOT NULL DEFAULT 'unknown',
  min_ef_memo_tier TEXT NOT NULL DEFAULT 'unknown',
  phase2_memo_tier TEXT NOT NULL DEFAULT 'unknown',
  phase2_memo_retried TEXT NOT NULL DEFAULT 'unknown',
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
    memory_strategy,
    min_ef_memo_tier,
    phase2_memo_tier,
    phase2_memo_retried,
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

INSERT INTO solver_runtime_aggregates_v6 (
  date_key,
  diagnostic_version,
  solver_version,
  solver_phase,
  solver_backend,
  fallback_from,
  fallback_reason,
  memory_strategy,
  min_ef_memo_tier,
  phase2_memo_tier,
  phase2_memo_retried,
  grade,
  level,
  exp_bucket,
  stock_bucket_blue,
  stock_bucket_purple,
  stock_bucket_yellow,
  node_count_bucket,
  attempted_node_count_bucket,
  solve_ms_bucket,
  events,
  last_seen
)
SELECT
  date_key,
  diagnostic_version,
  solver_version,
  solver_phase,
  solver_backend,
  fallback_from,
  fallback_reason,
  'unknown',
  'unknown',
  'unknown',
  'unknown',
  grade,
  level,
  exp_bucket,
  stock_bucket_blue,
  stock_bucket_purple,
  stock_bucket_yellow,
  node_count_bucket,
  attempted_node_count_bucket,
  solve_ms_bucket,
  events,
  last_seen
FROM solver_runtime_aggregates;

DROP TABLE solver_runtime_aggregates;
ALTER TABLE solver_runtime_aggregates_v6 RENAME TO solver_runtime_aggregates;

CREATE INDEX idx_solver_runtime_aggregates_backend
  ON solver_runtime_aggregates (solver_backend);
CREATE INDEX idx_solver_runtime_aggregates_fallback_context
  ON solver_runtime_aggregates (fallback_reason, grade, level);
