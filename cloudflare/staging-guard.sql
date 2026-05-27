-- STAGING ONLY.
-- Apply this file only to collection-kit-stats-staging. It creates the marker
-- required by reset-staging.sql. Never apply it to the production database.

CREATE TABLE IF NOT EXISTS staging_environment_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  environment TEXT NOT NULL CHECK (environment = 'staging')
);

INSERT OR REPLACE INTO staging_environment_guard (id, environment)
VALUES (1, 'staging');
