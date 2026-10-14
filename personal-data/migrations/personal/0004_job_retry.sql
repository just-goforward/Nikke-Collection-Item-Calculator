ALTER TABLE deletion_jobs ADD COLUMN retry_after INTEGER NOT NULL DEFAULT 0;
CREATE INDEX deletion_jobs_due ON deletion_jobs(retry_after, created_at, user_id);
