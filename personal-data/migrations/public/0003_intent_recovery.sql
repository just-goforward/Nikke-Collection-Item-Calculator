ALTER TABLE privacy_fence ADD COLUMN reconciliation_gate INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_gate IN (0, 1));
CREATE TABLE privacy_intents (
  intent_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX privacy_intents_expiry ON privacy_intents(expires_at);
CREATE TRIGGER privacy_intent_admitted AFTER INSERT ON privacy_intents
BEGIN
  UPDATE privacy_fence SET pending_intents = pending_intents + 1,
    intent_version = intent_version + 1 WHERE singleton = 1;
END;
CREATE TRIGGER privacy_intent_released AFTER DELETE ON privacy_intents
BEGIN
  UPDATE privacy_fence SET pending_intents = max(0, pending_intents - 1) WHERE singleton = 1;
END;
