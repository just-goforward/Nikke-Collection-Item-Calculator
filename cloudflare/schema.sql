CREATE TABLE IF NOT EXISTS event_ids (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_aggregates (
  date_key TEXT NOT NULL,
  grade TEXT NOT NULL,
  level INTEGER NOT NULL,
  exp_bucket INTEGER NOT NULL,
  kit TEXT NOT NULL,
  recommended_uses INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  success_attempt INTEGER NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  great_successes INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key,
    grade,
    level,
    exp_bucket,
    kit,
    recommended_uses,
    outcome,
    success_attempt
  )
);

CREATE INDEX IF NOT EXISTS idx_event_aggregates_date ON event_aggregates (date_key);
CREATE INDEX IF NOT EXISTS idx_event_aggregates_kit ON event_aggregates (kit);
CREATE INDEX IF NOT EXISTS idx_event_aggregates_date_grade_level_kit ON event_aggregates (date_key, grade, level, kit);

CREATE TABLE IF NOT EXISTS referrer_aggregates (
  date_key TEXT NOT NULL,
  source_host TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key,
    source_host
  )
);

CREATE INDEX IF NOT EXISTS idx_referrer_aggregates_date ON referrer_aggregates (date_key);

CREATE TABLE IF NOT EXISTS client_env_aggregates (
  date_key TEXT NOT NULL,
  browser TEXT NOT NULL,
  browser_major TEXT NOT NULL,
  os TEXT NOT NULL,
  os_major TEXT NOT NULL,
  device_type TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key,
    browser,
    browser_major,
    os,
    os_major,
    device_type
  )
);

CREATE INDEX IF NOT EXISTS idx_client_env_aggregates_date ON client_env_aggregates (date_key);

CREATE TABLE IF NOT EXISTS solver_diagnostic_aggregates (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  solver_version TEXT NOT NULL,
  solver_phase TEXT NOT NULL,
  grade TEXT NOT NULL,
  level INTEGER NOT NULL,
  exp_bucket INTEGER NOT NULL,
  strategy TEXT NOT NULL,
  stock_bucket_blue TEXT NOT NULL,
  stock_bucket_purple TEXT NOT NULL,
  stock_bucket_yellow TEXT NOT NULL,
  recommended_kit TEXT NOT NULL,
  recommended_uses_bucket TEXT NOT NULL,
  candidate_count_bucket TEXT NOT NULL,
  probability_gap_bucket TEXT NOT NULL,
  resource_cost_bucket TEXT NOT NULL,
  legacy_supply_cost_bucket TEXT NOT NULL DEFAULT '0',
  total_expected_cost_bucket TEXT NOT NULL,
  blue_share_bucket TEXT NOT NULL,
  min_autonomy_days_bucket TEXT NOT NULL,
  changed_from_single TEXT NOT NULL,
  changed_from_legacy_supply TEXT NOT NULL,
  legacy_private_stats_available INTEGER NOT NULL,
  legacy_event_aggregate_matchable INTEGER NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key,
    diagnostic_version,
    solver_version,
    solver_phase,
    grade,
    level,
    exp_bucket,
    strategy,
    stock_bucket_blue,
    stock_bucket_purple,
    stock_bucket_yellow,
    recommended_kit,
    recommended_uses_bucket,
    candidate_count_bucket,
    probability_gap_bucket,
    resource_cost_bucket,
    legacy_supply_cost_bucket,
    total_expected_cost_bucket,
    blue_share_bucket,
    min_autonomy_days_bucket,
    changed_from_single,
    changed_from_legacy_supply,
    legacy_private_stats_available,
    legacy_event_aggregate_matchable
  )
);

CREATE INDEX IF NOT EXISTS idx_solver_diagnostic_aggregates_date
  ON solver_diagnostic_aggregates (date_key);
CREATE INDEX IF NOT EXISTS idx_solver_diagnostic_aggregates_strategy
  ON solver_diagnostic_aggregates (strategy);
CREATE INDEX IF NOT EXISTS idx_solver_diagnostic_aggregates_grade_level
  ON solver_diagnostic_aggregates (grade, level);

CREATE TABLE IF NOT EXISTS solver_node_count_aggregates (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  solver_version TEXT NOT NULL,
  solver_phase TEXT NOT NULL,
  node_count_bucket TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key,
    diagnostic_version,
    solver_version,
    solver_phase,
    node_count_bucket
  )
);

CREATE INDEX IF NOT EXISTS idx_solver_node_count_aggregates_date
  ON solver_node_count_aggregates (date_key);
