ALTER TABLE consent_reservations ADD COLUMN attempt_nonce TEXT;
ALTER TABLE consent_reservations ADD COLUMN busy_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE consent_reservations ADD COLUMN maintenance_after INTEGER NOT NULL DEFAULT 0;
CREATE INDEX consent_reservations_due
  ON consent_reservations(maintenance_after, created_at, user_id);
