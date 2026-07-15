CREATE TABLE IF NOT EXISTS calculation_locale_aggregates (
  date_key TEXT NOT NULL,
  diagnostic_version INTEGER NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('ko', 'ja', 'en')),
  requested_backend TEXT NOT NULL,
  terminal_backend TEXT NOT NULL,
  execution_kind TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (
    date_key,
    diagnostic_version,
    locale,
    requested_backend,
    terminal_backend,
    execution_kind
  )
);

CREATE INDEX IF NOT EXISTS idx_calculation_locale_aggregates_locale
  ON calculation_locale_aggregates (locale, execution_kind);
