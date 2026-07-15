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
