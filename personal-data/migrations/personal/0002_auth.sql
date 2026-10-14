ALTER TABLE accounts ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1));
ALTER TABLE sessions ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sessions_idle_expiry ON sessions(idle_expires_at);
CREATE INDEX sessions_max_expiry ON sessions(max_expires_at);
-- M1 flows were never issued by an OAuth endpoint. Discard ephemeral pending data.
DELETE FROM oauth_transactions;
ALTER TABLE oauth_transactions DROP COLUMN consumed_at;
ALTER TABLE oauth_transactions ADD COLUMN nonce TEXT NOT NULL DEFAULT '';
ALTER TABLE oauth_transactions ADD COLUMN started_epoch INTEGER NOT NULL DEFAULT 0;
CREATE TABLE auth_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch INTEGER NOT NULL CHECK (epoch >= 0)
);
INSERT INTO auth_control VALUES (1, 0);
CREATE TRIGGER auth_epoch_monotonic BEFORE UPDATE ON auth_control
WHEN NEW.epoch < OLD.epoch
BEGIN
  SELECT RAISE(ABORT, 'auth_epoch_regression');
END;
CREATE TABLE login_rates (
  rate_key TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (rate_key, bucket)
);
-- Does not cascade: a delayed anonymous callback must not recreate a deleted identity.
CREATE TABLE blocked_identities (
  identity_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE deletion_jobs (
  user_id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fence_generation INTEGER NOT NULL
);
