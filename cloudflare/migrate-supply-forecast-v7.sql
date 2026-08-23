CREATE TABLE solver_diagnostic_aggregates_v7 (
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
    date_key, diagnostic_version, forecast_id, solver_version, solver_phase, grade, level,
    exp_bucket, strategy, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
    recommended_kit, recommended_uses_bucket, candidate_count_bucket, probability_gap_bucket,
    resource_cost_bucket, legacy_supply_cost_bucket, total_expected_cost_bucket,
    blue_share_bucket, min_autonomy_days_bucket, changed_from_single,
    changed_from_legacy_supply, legacy_private_stats_available,
    legacy_event_aggregate_matchable
  )
);

INSERT INTO solver_diagnostic_aggregates_v7 (
  date_key, diagnostic_version, forecast_id, solver_version, solver_phase, grade, level,
  exp_bucket, strategy, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
  recommended_kit, recommended_uses_bucket, candidate_count_bucket, probability_gap_bucket,
  resource_cost_bucket, legacy_supply_cost_bucket, total_expected_cost_bucket,
  blue_share_bucket, min_autonomy_days_bucket, changed_from_single,
  changed_from_legacy_supply, legacy_private_stats_available,
  legacy_event_aggregate_matchable, events, last_seen
)
SELECT
  date_key, diagnostic_version, 'legacy-unversioned', solver_version, solver_phase, grade, level,
  exp_bucket, strategy, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
  recommended_kit, recommended_uses_bucket, candidate_count_bucket, probability_gap_bucket,
  resource_cost_bucket, legacy_supply_cost_bucket, total_expected_cost_bucket,
  blue_share_bucket, min_autonomy_days_bucket, changed_from_single,
  changed_from_legacy_supply, legacy_private_stats_available,
  legacy_event_aggregate_matchable, events, last_seen
FROM solver_diagnostic_aggregates;

DROP TABLE solver_diagnostic_aggregates;
ALTER TABLE solver_diagnostic_aggregates_v7 RENAME TO solver_diagnostic_aggregates;
CREATE INDEX idx_solver_diagnostic_aggregates_strategy
  ON solver_diagnostic_aggregates (strategy);
CREATE INDEX idx_solver_diagnostic_aggregates_grade_level
  ON solver_diagnostic_aggregates (grade, level);

CREATE TABLE solver_runtime_aggregates_v7 (
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
    date_key, diagnostic_version, forecast_id, solver_version, solver_phase, solver_backend,
    fallback_from, fallback_reason, memory_strategy, min_ef_memo_tier, phase2_memo_tier,
    phase2_memo_retried, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
    stock_bucket_yellow, node_count_bucket, attempted_node_count_bucket, solve_ms_bucket
  )
);

INSERT INTO solver_runtime_aggregates_v7 (
  date_key, diagnostic_version, forecast_id, solver_version, solver_phase, solver_backend,
  fallback_from, fallback_reason, memory_strategy, min_ef_memo_tier, phase2_memo_tier,
  phase2_memo_retried, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
  stock_bucket_yellow, node_count_bucket, attempted_node_count_bucket, solve_ms_bucket,
  events, last_seen
)
SELECT
  date_key, diagnostic_version, 'legacy-unversioned', solver_version, solver_phase, solver_backend,
  fallback_from, fallback_reason, memory_strategy, min_ef_memo_tier, phase2_memo_tier,
  phase2_memo_retried, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
  stock_bucket_yellow, node_count_bucket, attempted_node_count_bucket, solve_ms_bucket,
  events, last_seen
FROM solver_runtime_aggregates;

DROP TABLE solver_runtime_aggregates;
ALTER TABLE solver_runtime_aggregates_v7 RENAME TO solver_runtime_aggregates;
CREATE INDEX idx_solver_runtime_aggregates_backend
  ON solver_runtime_aggregates (solver_backend);
CREATE INDEX idx_solver_runtime_aggregates_fallback_context
  ON solver_runtime_aggregates (fallback_reason, grade, level);

CREATE TABLE solver_cache_aggregates_v7 (
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
    date_key, diagnostic_version, forecast_id, requested_backend, terminal_backend,
    execution_kind, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
    stock_bucket_yellow
  )
);

INSERT INTO solver_cache_aggregates_v7 (
  date_key, diagnostic_version, forecast_id, requested_backend, terminal_backend,
  execution_kind, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
  stock_bucket_yellow, events, last_seen
)
SELECT
  date_key, diagnostic_version, 'legacy-unversioned', requested_backend, terminal_backend,
  execution_kind, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
  stock_bucket_yellow, events, last_seen
FROM solver_cache_aggregates;

DROP TABLE solver_cache_aggregates;
ALTER TABLE solver_cache_aggregates_v7 RENAME TO solver_cache_aggregates;
CREATE INDEX idx_solver_cache_aggregates_backend
  ON solver_cache_aggregates (requested_backend, execution_kind);

CREATE TABLE calculation_locale_aggregates_v7 (
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
    date_key, diagnostic_version, forecast_id, locale, requested_backend, terminal_backend,
    execution_kind
  )
);

INSERT INTO calculation_locale_aggregates_v7 (
  date_key, diagnostic_version, forecast_id, locale, requested_backend, terminal_backend,
  execution_kind, events, last_seen
)
SELECT
  date_key, diagnostic_version, 'legacy-unversioned', locale, requested_backend,
  terminal_backend, execution_kind, events, last_seen
FROM calculation_locale_aggregates;

DROP TABLE calculation_locale_aggregates;
ALTER TABLE calculation_locale_aggregates_v7 RENAME TO calculation_locale_aggregates;
CREATE INDEX idx_calculation_locale_aggregates_locale
  ON calculation_locale_aggregates (locale, execution_kind);

CREATE TABLE solver_recovery_rung_aggregates_v7 (
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
    date_key, recovery_version, forecast_id, policy_version, requested_backend, rung_backend,
    rung_exit, memo_tier, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
    stock_bucket_yellow, device_type
  )
);

INSERT INTO solver_recovery_rung_aggregates_v7 (
  date_key, recovery_version, forecast_id, policy_version, requested_backend, rung_backend,
  rung_exit, memo_tier, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
  stock_bucket_yellow, device_type, events, last_seen
)
SELECT
  date_key, recovery_version, 'legacy-unversioned', policy_version, requested_backend,
  rung_backend, rung_exit, memo_tier, grade, level, exp_bucket, stock_bucket_blue,
  stock_bucket_purple, stock_bucket_yellow, device_type, events, last_seen
FROM solver_recovery_rung_aggregates;

DROP TABLE solver_recovery_rung_aggregates;
ALTER TABLE solver_recovery_rung_aggregates_v7 RENAME TO solver_recovery_rung_aggregates;
CREATE INDEX idx_solver_recovery_rung_backend
  ON solver_recovery_rung_aggregates (rung_backend, rung_exit);

CREATE TABLE solver_recovery_terminal_aggregates_v7 (
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
    date_key, recovery_version, forecast_id, policy_version, requested_backend, min_ef_exit,
    phase2_exit, js_exit, terminal_backend, terminal_outcome, grade, level, exp_bucket,
    stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow, device_type
  )
);

INSERT INTO solver_recovery_terminal_aggregates_v7 (
  date_key, recovery_version, forecast_id, policy_version, requested_backend, min_ef_exit,
  phase2_exit, js_exit, terminal_backend, terminal_outcome, grade, level, exp_bucket,
  stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow, device_type, events, last_seen
)
SELECT
  date_key, recovery_version, 'legacy-unversioned', policy_version, requested_backend,
  min_ef_exit, phase2_exit, js_exit, terminal_backend, terminal_outcome, grade, level,
  exp_bucket, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow, device_type,
  events, last_seen
FROM solver_recovery_terminal_aggregates;

DROP TABLE solver_recovery_terminal_aggregates;
ALTER TABLE solver_recovery_terminal_aggregates_v7 RENAME TO solver_recovery_terminal_aggregates;
CREATE INDEX idx_solver_recovery_terminal_outcome
  ON solver_recovery_terminal_aggregates (terminal_backend, terminal_outcome);
