CREATE TABLE IF NOT EXISTS solver_recovery_rung_aggregates (
  date_key TEXT NOT NULL,
  recovery_version INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  requested_backend TEXT NOT NULL,
  rung_backend TEXT NOT NULL,
  rung_exit TEXT NOT NULL,
  memo_tier TEXT NOT NULL,
  grade TEXT NOT NULL,
  level INTEGER NOT NULL,
  exp_bucket INTEGER NOT NULL,
  stock_bucket_blue TEXT NOT NULL,
  stock_bucket_purple TEXT NOT NULL,
  stock_bucket_yellow TEXT NOT NULL,
  device_type TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key, recovery_version, policy_version, requested_backend, rung_backend, rung_exit,
    memo_tier, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
    stock_bucket_yellow, device_type
  )
);

CREATE TABLE IF NOT EXISTS solver_recovery_terminal_aggregates (
  date_key TEXT NOT NULL,
  recovery_version INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  requested_backend TEXT NOT NULL,
  min_ef_exit TEXT NOT NULL,
  phase2_exit TEXT NOT NULL,
  js_exit TEXT NOT NULL,
  terminal_backend TEXT NOT NULL,
  terminal_outcome TEXT NOT NULL,
  grade TEXT NOT NULL,
  level INTEGER NOT NULL,
  exp_bucket INTEGER NOT NULL,
  stock_bucket_blue TEXT NOT NULL,
  stock_bucket_purple TEXT NOT NULL,
  stock_bucket_yellow TEXT NOT NULL,
  device_type TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key, recovery_version, policy_version, requested_backend, min_ef_exit, phase2_exit,
    js_exit, terminal_backend, terminal_outcome, grade, level, exp_bucket, stock_bucket_blue,
    stock_bucket_purple, stock_bucket_yellow, device_type
  )
);

CREATE INDEX IF NOT EXISTS idx_solver_recovery_rung_backend
  ON solver_recovery_rung_aggregates (rung_backend, rung_exit);
CREATE INDEX IF NOT EXISTS idx_solver_recovery_terminal_outcome
  ON solver_recovery_terminal_aggregates (terminal_backend, terminal_outcome);
