PRAGMA foreign_keys = ON;

ALTER TABLE discord_staging_adoptions
  ADD COLUMN discord_channel_id TEXT
  CHECK (discord_channel_id IS NULL OR length(discord_channel_id) BETWEEN 1 AND 24);

ALTER TABLE discord_staging_adoptions
  ADD COLUMN discord_message_id TEXT
  CHECK (discord_message_id IS NULL OR length(discord_message_id) BETWEEN 1 AND 24);

CREATE UNIQUE INDEX IF NOT EXISTS discord_staging_adoptions_message_id_unique_idx
  ON discord_staging_adoptions(discord_message_id)
  WHERE discord_message_id IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (6, CURRENT_TIMESTAMP);
