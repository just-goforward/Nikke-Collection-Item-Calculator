CREATE TABLE forecast_v2_calendar_snapshots (
 snapshot_id TEXT PRIMARY KEY NOT NULL, range_start TEXT NOT NULL, range_end TEXT NOT NULL,
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64), created_at TEXT NOT NULL,
 CHECK(range_end>=range_start), UNIQUE(range_start,range_end,content_hash)
);
CREATE TABLE forecast_v2_calendar_days (
 snapshot_id TEXT NOT NULL REFERENCES forecast_v2_calendar_snapshots(snapshot_id),
 game_day TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(snapshot_id,game_day)
);
CREATE TABLE forecast_v2_calendar_event_links (
 snapshot_id TEXT NOT NULL, game_day TEXT NOT NULL, event_id TEXT NOT NULL, revision INTEGER NOT NULL,
 PRIMARY KEY(snapshot_id,game_day,event_id),
 FOREIGN KEY(snapshot_id,game_day) REFERENCES forecast_v2_calendar_days(snapshot_id,game_day),
 FOREIGN KEY(event_id,revision) REFERENCES forecast_v2_calendar_revisions(event_id,revision)
);
CREATE TABLE forecast_v2_calendar_active (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), snapshot_id TEXT NOT NULL REFERENCES forecast_v2_calendar_snapshots(snapshot_id),
 version INTEGER NOT NULL CHECK(version>0), updated_at TEXT NOT NULL
);
CREATE TRIGGER forecast_v2_calendar_active_cas BEFORE UPDATE ON forecast_v2_calendar_active
 WHEN NEW.version<>OLD.version+1 BEGIN SELECT RAISE(ABORT,'calendar_version_conflict'); END;
CREATE TABLE forecast_v2_calendar_diffs (
 snapshot_id TEXT NOT NULL REFERENCES forecast_v2_calendar_snapshots(snapshot_id),
 diff_key TEXT NOT NULL, previous_snapshot_id TEXT REFERENCES forecast_v2_calendar_snapshots(snapshot_id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), PRIMARY KEY(snapshot_id,diff_key)
);
CREATE TABLE forecast_v2_notification_outbox (
 outbox_id TEXT PRIMARY KEY NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('b_report','decision_request','calendar_changed','decision_reminder')),
 snapshot_id TEXT REFERENCES forecast_v2_calendar_snapshots(snapshot_id),
 decision_id TEXT REFERENCES forecast_v2_decision_requests(decision_id),
 channel_role TEXT NOT NULL CHECK(channel_role IN ('approval','activity')),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','dead')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at INTEGER NOT NULL,
 lease_token TEXT, lease_until INTEGER, message_id TEXT, channel_id TEXT, error_code TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((kind='calendar_changed' AND snapshot_id IS NOT NULL AND channel_role='activity')
 OR (kind<>'calendar_changed' AND decision_id IS NOT NULL AND channel_role='approval'))
);
CREATE INDEX forecast_v2_notification_due ON forecast_v2_notification_outbox(state,next_attempt_at);
INSERT INTO schema_migrations(version,applied_at) VALUES(33,CURRENT_TIMESTAMP);
