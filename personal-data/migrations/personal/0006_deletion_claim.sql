-- A guarded PERSONAL claim/outbox precedes PUBLIC invalidation, under a PUBLIC intent.
-- Legacy jobs already hold a fence; only new guarded claims start unready.
ALTER TABLE deletion_jobs ADD COLUMN fence_ready INTEGER NOT NULL DEFAULT 1 CHECK (fence_ready IN (0, 1));
