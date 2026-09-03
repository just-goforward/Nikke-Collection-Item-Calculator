-- STAGING ONLY: reset disposable validation data.
-- Execute this file only with the collection-kit-stats-staging database name
-- and --env staging. Every DELETE requires the staging-only marker created by
-- staging-guard.sql. On a database without that guard, this file fails closed.

DELETE FROM event_ids
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM rate_limits
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM event_aggregates
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM referrer_aggregates
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM client_env_aggregates
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM solver_diagnostic_aggregates
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM calculation_locale_aggregates
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM solver_runtime_aggregates
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM solver_cache_aggregates
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM solver_recovery_rung_aggregates
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM solver_recovery_terminal_aggregates
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM runtime_invariant_aggregates
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM event_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM referrer_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM client_env_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM solver_diagnostic_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM calculation_locale_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM solver_runtime_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM solver_cache_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM solver_recovery_rung_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM solver_recovery_terminal_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM runtime_invariant_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM forecast_profile_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM solver_failure_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM stats_rejection_event_ids
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM stats_submission_rejection_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);

DELETE FROM stats_delivery_health_aggregates_game_day
WHERE EXISTS (
  SELECT 1 FROM staging_environment_guard WHERE id = 1 AND environment = 'staging'
);
