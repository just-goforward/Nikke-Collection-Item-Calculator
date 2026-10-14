-- Ephemeral flows must restart across the change in deletion-fence semantics.
DELETE FROM oauth_transactions;
DROP TABLE blocked_identities;
ALTER TABLE deletion_jobs DROP COLUMN identity_hash;
CREATE TABLE identity_deletion_fences (
  identity_hash TEXT PRIMARY KEY,
  deleted_epoch INTEGER NOT NULL CHECK (deleted_epoch > 0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX identity_fence_expiry ON identity_deletion_fences(expires_at);
