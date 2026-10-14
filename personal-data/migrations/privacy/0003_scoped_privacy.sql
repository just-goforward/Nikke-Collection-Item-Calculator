-- Restore safety is keyed by the deleted account ID, not a permanent Google identity ban.
DROP INDEX deletion_identity;
ALTER TABLE tombstones DROP COLUMN identity_hash;
-- Reservation does not change consent. PUBLIC must be fenced before committing its decision.
CREATE TABLE consent_reservations (
  user_id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  participation INTEGER NOT NULL CHECK (participation IN (0, 1)),
  write_nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fence_generation INTEGER
);
