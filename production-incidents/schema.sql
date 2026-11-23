CREATE TABLE incidents (
  fingerprint TEXT PRIMARY KEY,
  seen INTEGER NOT NULL,
  build TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('source','capacity','binding','worker','other','canary')),
  stage TEXT NOT NULL CHECK(stage IN ('manual','outcome','conversion','private')),
  CHECK ((reason='canary')=(stage='private'))
);
CREATE INDEX incidents_seen ON incidents(seen);
CREATE TABLE notifications (
  day INTEGER NOT NULL, build TEXT NOT NULL, reason TEXT NOT NULL, stage TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','uncertain','sent','blocked')),
  attempts INTEGER NOT NULL DEFAULT 0, next INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,build,reason,stage)
);
CREATE TRIGGER enqueue AFTER INSERT ON incidents BEGIN
  INSERT INTO notifications(day,build,reason,stage) VALUES(NEW.seen/86400, NEW.build,NEW.reason,NEW.stage)
  ON CONFLICT(day,build,reason,stage) DO NOTHING;
END;
