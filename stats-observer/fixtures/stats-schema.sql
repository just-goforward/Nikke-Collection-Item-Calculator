CREATE TABLE IF NOT EXISTS event_ids (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_ids_created_at ON event_ids (created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires_at ON rate_limits (expires_at);

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

CREATE TABLE IF NOT EXISTS solver_diagnostic_aggregates (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
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
    forecast_id,
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

CREATE INDEX IF NOT EXISTS idx_solver_diagnostic_aggregates_strategy
  ON solver_diagnostic_aggregates (strategy);
CREATE INDEX IF NOT EXISTS idx_solver_diagnostic_aggregates_grade_level
  ON solver_diagnostic_aggregates (grade, level);

CREATE TABLE IF NOT EXISTS solver_runtime_aggregates (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
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
    forecast_id,
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

CREATE INDEX IF NOT EXISTS idx_solver_runtime_aggregates_backend
  ON solver_runtime_aggregates (solver_backend);
CREATE INDEX IF NOT EXISTS idx_solver_runtime_aggregates_fallback_context
  ON solver_runtime_aggregates (fallback_reason, grade, level);

CREATE TABLE IF NOT EXISTS solver_cache_aggregates (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
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
    forecast_id,
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

CREATE TABLE IF NOT EXISTS calculation_locale_aggregates (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('ko', 'ja', 'en')),
  requested_backend TEXT NOT NULL,
  terminal_backend TEXT NOT NULL,
  execution_kind TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key,
    diagnostic_version,
    forecast_id,
    locale,
    requested_backend,
    terminal_backend,
    execution_kind
  )
);

CREATE INDEX IF NOT EXISTS idx_calculation_locale_aggregates_locale
  ON calculation_locale_aggregates (locale, execution_kind);

CREATE TABLE IF NOT EXISTS solver_recovery_rung_aggregates (
  date_key TEXT NOT NULL,
  recovery_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
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
    date_key, recovery_version, forecast_id, policy_version, requested_backend, rung_backend, rung_exit,
    memo_tier, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
    stock_bucket_yellow, device_type
  )
);

CREATE TABLE IF NOT EXISTS solver_recovery_terminal_aggregates (
  date_key TEXT NOT NULL,
  recovery_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
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
    date_key, recovery_version, forecast_id, policy_version, requested_backend, min_ef_exit, phase2_exit,
    js_exit, terminal_backend, terminal_outcome, grade, level, exp_bucket, stock_bucket_blue,
    stock_bucket_purple, stock_bucket_yellow, device_type
  )
);

CREATE INDEX IF NOT EXISTS idx_solver_recovery_rung_backend
  ON solver_recovery_rung_aggregates (rung_backend, rung_exit);
CREATE INDEX IF NOT EXISTS idx_solver_recovery_terminal_outcome
  ON solver_recovery_terminal_aggregates (terminal_backend, terminal_outcome);

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

-- Operational solver failure and telemetry delivery indexes. These tables never
-- store raw inventory, IP addresses, user-agent strings, error messages, or stacks.
CREATE TABLE IF NOT EXISTS solver_failure_aggregates_game_day (
  date_key TEXT NOT NULL,
  recovery_version INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  app_revision TEXT NOT NULL,
  ingest_revision TEXT NOT NULL,
  forecast_id TEXT NOT NULL,
  forecast_profile_id TEXT NOT NULL,
  rust_min_ef_solver_version TEXT NOT NULL,
  rust_phase2_solver_version TEXT NOT NULL,
  js_phase2_solver_version TEXT NOT NULL,
  requested_backend TEXT NOT NULL,
  min_ef_exit TEXT NOT NULL,
  phase2_exit TEXT NOT NULL,
  js_exit TEXT NOT NULL,
  terminal_backend TEXT NOT NULL,
  grade TEXT NOT NULL,
  level INTEGER NOT NULL,
  exp_bucket INTEGER NOT NULL,
  stock_bucket_blue TEXT NOT NULL,
  stock_bucket_purple TEXT NOT NULL,
  stock_bucket_yellow TEXT NOT NULL,
  browser TEXT NOT NULL,
  browser_major TEXT NOT NULL,
  os TEXT NOT NULL,
  os_major TEXT NOT NULL,
  device_type TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key, recovery_version, policy_version, app_revision, ingest_revision,
    forecast_id, forecast_profile_id, rust_min_ef_solver_version,
    rust_phase2_solver_version, js_phase2_solver_version, requested_backend,
    min_ef_exit, phase2_exit, js_exit, terminal_backend, grade, level, exp_bucket,
    stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow, browser,
    browser_major, os, os_major, device_type
  )
);
CREATE INDEX IF NOT EXISTS idx_solver_failure_last_seen
  ON solver_failure_aggregates_game_day (last_seen, terminal_backend);

CREATE TABLE IF NOT EXISTS stats_rejection_event_ids (
  event_id TEXT PRIMARY KEY,
  rejection_code TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stats_rejection_event_ids_created_at
  ON stats_rejection_event_ids (created_at);

CREATE TABLE IF NOT EXISTS stats_submission_rejection_aggregates_game_day (
  date_key TEXT NOT NULL,
  rejection_code TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  recovery_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  app_revision TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key, rejection_code, event_kind, recovery_version, policy_version, app_revision
  )
);
CREATE INDEX IF NOT EXISTS idx_stats_submission_rejection_last_seen
  ON stats_submission_rejection_aggregates_game_day (last_seen, rejection_code);

CREATE TABLE IF NOT EXISTS stats_delivery_health_aggregates_game_day (
  date_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  attempts_bucket TEXT NOT NULL,
  age_bucket TEXT NOT NULL,
  last_failure_class TEXT NOT NULL,
  app_revision TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key, outcome, event_kind, attempts_bucket, age_bucket,
    last_failure_class, app_revision
  )
);
CREATE INDEX IF NOT EXISTS idx_stats_delivery_health_last_seen
  ON stats_delivery_health_aggregates_game_day (last_seen, outcome);

-- Preserve all pre-v9 KST calendar-date aggregates in their existing tables.
-- New Worker versions write only to these 05:00 KST game-day tables.

CREATE TABLE IF NOT EXISTS event_aggregates_game_day (
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

CREATE INDEX IF NOT EXISTS idx_event_aggregates_game_day_date_grade_level_kit
  ON event_aggregates_game_day (date_key, grade, level, kit);

CREATE TABLE IF NOT EXISTS referrer_aggregates_game_day (
  date_key TEXT NOT NULL,
  source_host TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (date_key, source_host)
);

CREATE TABLE IF NOT EXISTS client_env_aggregates_game_day (
  date_key TEXT NOT NULL,
  browser TEXT NOT NULL,
  browser_major TEXT NOT NULL,
  os TEXT NOT NULL,
  os_major TEXT NOT NULL,
  device_type TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (date_key, browser, browser_major, os, os_major, device_type)
);

CREATE TABLE IF NOT EXISTS solver_diagnostic_aggregates_game_day (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
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
    forecast_id,
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

CREATE INDEX IF NOT EXISTS idx_solver_diagnostic_aggregates_game_day_strategy
  ON solver_diagnostic_aggregates_game_day (strategy);
CREATE INDEX IF NOT EXISTS idx_solver_diagnostic_aggregates_game_day_grade_level
  ON solver_diagnostic_aggregates_game_day (grade, level);

CREATE TABLE IF NOT EXISTS solver_runtime_aggregates_game_day (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
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
    forecast_id,
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

CREATE INDEX IF NOT EXISTS idx_solver_runtime_aggregates_game_day_backend
  ON solver_runtime_aggregates_game_day (solver_backend);
CREATE INDEX IF NOT EXISTS idx_solver_runtime_aggregates_game_day_fallback_context
  ON solver_runtime_aggregates_game_day (fallback_reason, grade, level);

CREATE TABLE IF NOT EXISTS solver_cache_aggregates_game_day (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
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
    forecast_id,
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

CREATE INDEX IF NOT EXISTS idx_solver_cache_aggregates_game_day_backend
  ON solver_cache_aggregates_game_day (requested_backend, execution_kind);

CREATE TABLE IF NOT EXISTS calculation_locale_aggregates_game_day (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('ko', 'ja', 'en')),
  requested_backend TEXT NOT NULL,
  terminal_backend TEXT NOT NULL,
  execution_kind TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key,
    diagnostic_version,
    forecast_id,
    locale,
    requested_backend,
    terminal_backend,
    execution_kind
  )
);

CREATE INDEX IF NOT EXISTS idx_calculation_locale_aggregates_game_day_locale
  ON calculation_locale_aggregates_game_day (locale, execution_kind);

CREATE TABLE IF NOT EXISTS solver_recovery_rung_aggregates_game_day (
  date_key TEXT NOT NULL,
  recovery_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
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
    date_key, recovery_version, forecast_id, policy_version, requested_backend, rung_backend, rung_exit,
    memo_tier, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
    stock_bucket_yellow, device_type
  )
);

CREATE TABLE IF NOT EXISTS solver_recovery_terminal_aggregates_game_day (
  date_key TEXT NOT NULL,
  recovery_version INTEGER NOT NULL,
  forecast_id TEXT NOT NULL,
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
    date_key, recovery_version, forecast_id, policy_version, requested_backend, min_ef_exit, phase2_exit,
    js_exit, terminal_backend, terminal_outcome, grade, level, exp_bucket, stock_bucket_blue,
    stock_bucket_purple, stock_bucket_yellow, device_type
  )
);

CREATE INDEX IF NOT EXISTS idx_solver_recovery_rung_game_day_backend
  ON solver_recovery_rung_aggregates_game_day (rung_backend, rung_exit);
CREATE INDEX IF NOT EXISTS idx_solver_recovery_terminal_game_day_outcome
  ON solver_recovery_terminal_aggregates_game_day (terminal_backend, terminal_outcome);

CREATE TABLE IF NOT EXISTS runtime_invariant_aggregates_game_day (
  date_key TEXT NOT NULL,
  invariant_version INTEGER NOT NULL,
  invariant_code TEXT NOT NULL,
  component TEXT NOT NULL,
  lane TEXT NOT NULL,
  device_type TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (date_key, invariant_version, invariant_code, component, lane, device_type)
);

CREATE INDEX IF NOT EXISTS idx_runtime_invariant_aggregates_game_day_code
  ON runtime_invariant_aggregates_game_day (invariant_code, component, lane);

CREATE TABLE IF NOT EXISTS forecast_profile_aggregates_game_day (
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

CREATE INDEX IF NOT EXISTS idx_forecast_profile_aggregates_game_day_profile
  ON forecast_profile_aggregates_game_day (forecast_id, forecast_profile_id, event_kind);
