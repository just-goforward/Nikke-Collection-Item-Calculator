CREATE TABLE privacy_fence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  blocked INTEGER NOT NULL CHECK (blocked IN (0, 1))
);
-- Publication is disabled until a future, reviewed reconciliation protocol exists.
INSERT INTO privacy_fence VALUES (1, 0, 1);
CREATE TRIGGER monotonic_fence BEFORE UPDATE ON privacy_fence
WHEN NEW.generation < OLD.generation
BEGIN
  SELECT RAISE(ABORT, 'fence_regression');
END;
CREATE TRIGGER persistent_fence BEFORE DELETE ON privacy_fence
BEGIN
  SELECT RAISE(ABORT, 'fence_deletion');
END;
CREATE TABLE weekly_releases (
  release_id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  fence_generation INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  published_at INTEGER NOT NULL
);
CREATE TABLE disclosure_history (
  release_id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  fence_generation INTEGER NOT NULL,
  disclosure_policy_version TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  invalidated_at INTEGER
);
CREATE TABLE current_release (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  release_id TEXT REFERENCES weekly_releases(release_id),
  fence_generation INTEGER NOT NULL
);
INSERT INTO current_release VALUES (1, NULL, 0);
CREATE TRIGGER release_fence BEFORE INSERT ON weekly_releases
WHEN NOT EXISTS (
  SELECT 1 FROM privacy_fence
  WHERE singleton = 1 AND blocked = 0 AND generation = NEW.fence_generation
)
BEGIN
  SELECT RAISE(ABORT, 'privacy_fenced');
END;
CREATE TRIGGER pointer_fence BEFORE UPDATE ON current_release
WHEN NEW.release_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM privacy_fence f JOIN weekly_releases r
  ON r.release_id = NEW.release_id AND r.fence_generation = f.generation
  WHERE f.singleton = 1 AND f.blocked = 0 AND NEW.fence_generation = f.generation
)
BEGIN
  SELECT RAISE(ABORT, 'privacy_fenced');
END;
