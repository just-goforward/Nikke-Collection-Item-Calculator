ALTER TABLE consent_decisions ADD COLUMN fence_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE consent_decisions ADD COLUMN last_write_nonce TEXT;
CREATE TABLE consent_operations (
  user_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  decision_version INTEGER NOT NULL,
  fence_generation INTEGER NOT NULL,
  PRIMARY KEY (user_id, op_id)
);
