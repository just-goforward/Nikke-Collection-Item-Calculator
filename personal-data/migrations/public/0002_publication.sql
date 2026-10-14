ALTER TABLE privacy_fence ADD COLUMN pending_intents INTEGER NOT NULL DEFAULT 0 CHECK (pending_intents >= 0);
ALTER TABLE privacy_fence ADD COLUMN intent_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE privacy_fence ADD COLUMN publisher_token TEXT;
ALTER TABLE privacy_fence ADD COLUMN activated_token TEXT;
ALTER TABLE weekly_releases ADD COLUMN state TEXT NOT NULL DEFAULT 'published' CHECK (state IN ('staged', 'published'));
ALTER TABLE weekly_releases ADD COLUMN intent_version INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER release_fence;
CREATE TRIGGER release_fence BEFORE INSERT ON weekly_releases
WHEN NOT EXISTS (
  SELECT 1 FROM privacy_fence f WHERE f.singleton = 1 AND f.pending_intents = 0
  AND f.generation = NEW.fence_generation AND f.intent_version = NEW.intent_version
  AND ((NEW.state = 'published' AND f.blocked = 0)
    OR (NEW.state = 'staged' AND f.publisher_token = NEW.release_id AND f.blocked = 1))
)
BEGIN
  SELECT RAISE(ABORT, 'privacy_fenced');
END;
DROP TRIGGER pointer_fence;
CREATE TRIGGER pointer_fence BEFORE UPDATE ON current_release
WHEN NEW.release_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM privacy_fence f JOIN weekly_releases r ON r.release_id = NEW.release_id
  WHERE f.singleton = 1 AND f.blocked = 0 AND f.pending_intents = 0
  AND r.state = 'published' AND r.fence_generation = f.generation
  AND r.intent_version = f.intent_version AND NEW.fence_generation = f.generation
)
BEGIN
  SELECT RAISE(ABORT, 'privacy_fenced');
END;
CREATE TRIGGER monotonic_intents BEFORE UPDATE ON privacy_fence
WHEN NEW.intent_version < OLD.intent_version
BEGIN
  SELECT RAISE(ABORT, 'intent_regression');
END;
