CREATE TABLE forecast_v2_calendar_revisions (
 event_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 kind TEXT NOT NULL CHECK(kind IN ('maintenance','solo','collaboration')),
 status TEXT NOT NULL CHECK(status IN ('predicted','confirmed','pending','cancelled')),
 starts_at TEXT, ends_at TEXT, start_game_day TEXT, end_game_day TEXT,
 maintenance_event_id TEXT, maintenance_revision INTEGER,
 prediction_provenance_json TEXT CHECK(prediction_provenance_json IS NULL OR json_valid(prediction_provenance_json)),
 source_feed_ids_json TEXT NOT NULL CHECK(json_valid(source_feed_ids_json) AND json_type(source_feed_ids_json)='array'),
 created_at TEXT NOT NULL,
 PRIMARY KEY(event_id,revision),
 FOREIGN KEY(maintenance_event_id,maintenance_revision) REFERENCES forecast_v2_calendar_revisions(event_id,revision),
 CHECK((maintenance_event_id IS NULL)=(maintenance_revision IS NULL)),
 CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at>=starts_at)
);
CREATE TABLE forecast_v2_calendar_heads (
 event_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL,
 FOREIGN KEY(event_id,revision) REFERENCES forecast_v2_calendar_revisions(event_id,revision)
);
CREATE TRIGGER forecast_v2_calendar_head_cas BEFORE UPDATE ON forecast_v2_calendar_heads
 WHEN NEW.event_id<>OLD.event_id OR NEW.revision<>OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'calendar_revision_conflict'); END;
CREATE TABLE forecast_v2_decision_requests (
 decision_id TEXT PRIMARY KEY NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('solo_review','grant_date','collaboration','maintenance','grant_quantity')),
 -- No FK: a decision may name an event before its first head exists.
 event_id TEXT,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 expected_calendar_revision INTEGER NOT NULL CHECK(expected_calendar_revision>=0),
 expires_at TEXT NOT NULL, reminder_sent_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','resolved','expired','stale')),
 created_at TEXT NOT NULL
);
CREATE INDEX forecast_v2_decision_requests_status_expiry
 ON forecast_v2_decision_requests(status,expires_at);
CREATE TABLE forecast_v2_consumed_interactions (
 interaction_id TEXT PRIMARY KEY NOT NULL, decision_id TEXT NOT NULL REFERENCES forecast_v2_decision_requests(decision_id),
 consumed_at TEXT NOT NULL
);
CREATE TABLE forecast_v2_admin_commands (
 command_id TEXT PRIMARY KEY NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 -- A command may create the first head; it cannot reference an existing head here.
 event_id TEXT,
 decision_id TEXT UNIQUE REFERENCES forecast_v2_decision_requests(decision_id),
 expected_revision INTEGER NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TRIGGER forecast_v2_command_cas BEFORE INSERT ON forecast_v2_admin_commands
 WHEN NEW.event_id IS NOT NULL AND (
   (NEW.expected_revision=0 AND EXISTS(
     SELECT 1 FROM forecast_v2_calendar_heads WHERE event_id=NEW.event_id
   )) OR
   (NEW.expected_revision<>0 AND NOT EXISTS(
     SELECT 1 FROM forecast_v2_calendar_heads WHERE event_id=NEW.event_id AND revision=NEW.expected_revision
   ))
 )
 BEGIN SELECT RAISE(ABORT,'calendar_revision_conflict'); END;
CREATE TABLE forecast_v2_decision_results (
 decision_id TEXT PRIMARY KEY NOT NULL REFERENCES forecast_v2_decision_requests(decision_id),
 interaction_id TEXT NOT NULL UNIQUE REFERENCES forecast_v2_consumed_interactions(interaction_id),
 result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL
);
CREATE TRIGGER forecast_v2_result_update BEFORE UPDATE ON forecast_v2_decision_results
 BEGIN SELECT RAISE(ABORT,'decision_result_immutable'); END;
CREATE TRIGGER forecast_v2_result_delete BEFORE DELETE ON forecast_v2_decision_results
 BEGIN SELECT RAISE(ABORT,'decision_result_immutable'); END;
CREATE TRIGGER forecast_v2_result_replace BEFORE INSERT ON forecast_v2_decision_results
 WHEN EXISTS(SELECT 1 FROM forecast_v2_decision_results WHERE decision_id=NEW.decision_id OR interaction_id=NEW.interaction_id)
 BEGIN SELECT RAISE(ABORT,'decision_result_immutable'); END;
INSERT INTO schema_migrations(version,applied_at) VALUES(31,CURRENT_TIMESTAMP);
