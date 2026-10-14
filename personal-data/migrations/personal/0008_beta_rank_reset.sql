-- Beta reset of derived prototype data, not user-authored content.
-- No deployment exists; future publication requires a redesigned, reviewed policy.
DELETE FROM self_percentiles;

-- Derived rank projections are not user-authored content, including after a restore.
DROP TRIGGER archive_quota;
CREATE TRIGGER archive_quota BEFORE INSERT ON pending_archives
WHEN (
  COALESCE((SELECT length(CAST(document AS BLOB)) FROM workspaces WHERE user_id = NEW.user_id), 0)
  + COALESCE((SELECT sum(length(CAST(summary AS BLOB))) FROM stage_summaries WHERE user_id = NEW.user_id), 0)
  + COALESCE((SELECT sum(length(CAST(payload AS BLOB))) FROM pending_archives WHERE user_id = NEW.user_id), 0)
  + length(CAST(NEW.payload AS BLOB))
) > (SELECT quota_bytes FROM accounts WHERE user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'archive_quota_reached');
END;
