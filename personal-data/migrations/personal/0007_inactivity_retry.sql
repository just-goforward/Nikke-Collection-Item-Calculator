ALTER TABLE accounts ADD COLUMN inactivity_retry_after INTEGER NOT NULL DEFAULT 0;
DROP INDEX accounts_inactivity_ready;
CREATE INDEX accounts_inactivity_ready
  ON accounts(blocked, inactivity_retry_after, last_active_at, user_id);
