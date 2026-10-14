-- Independent privacy authority: do not restore this DB from a personal-data backup.
CREATE TABLE consent_decisions (
  user_id TEXT PRIMARY KEY,
  participation INTEGER NOT NULL CHECK (participation IN (0, 1)),
  decision_version INTEGER NOT NULL CHECK (decision_version > 0),
  decided_at INTEGER NOT NULL
);
CREATE TABLE tombstones (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('withdrawal', 'deletion')),
  identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64),
  created_at INTEGER NOT NULL,
  fence_generation INTEGER NOT NULL CHECK (fence_generation > 0),
  PRIMARY KEY (user_id, kind)
);
CREATE INDEX deletion_identity ON tombstones(identity_hash, kind);
CREATE TABLE privacy_operations (
  op_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('withdrawal', 'deletion')),
  fence_generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, op_id)
);
CREATE TRIGGER privacy_op_collision BEFORE INSERT ON privacy_operations
WHEN EXISTS (
  SELECT 1 FROM privacy_operations
  WHERE user_id = NEW.user_id AND op_id = NEW.op_id AND kind != NEW.kind
)
BEGIN
  SELECT RAISE(ABORT, 'op_id_conflict');
END;
