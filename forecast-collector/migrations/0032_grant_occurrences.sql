CREATE TABLE forecast_v2_grant_observations (
 observation_id TEXT PRIMARY KEY NOT NULL,
 version_id TEXT NOT NULL REFERENCES forecast_v2_post_versions(version_id),
 feed_id TEXT NOT NULL, ii_qty INTEGER NOT NULL CHECK(ii_qty>=0), box_qty INTEGER NOT NULL CHECK(box_qty>=0),
 candidate_dates_json TEXT NOT NULL CHECK(json_valid(candidate_dates_json) AND json_type(candidate_dates_json)='array'),
 date_basis TEXT NOT NULL CHECK(date_basis IN ('explicit_payment','in_post_datetime','maintenance_end','post_created','admin_selected','legacy_unverified')),
 created_at TEXT NOT NULL, UNIQUE(version_id,ii_qty,box_qty),
 CHECK(ii_qty+box_qty>0)
);
CREATE TABLE forecast_v2_grant_revisions (
 occurrence_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 grant_game_day TEXT NOT NULL, ii_qty INTEGER NOT NULL CHECK(ii_qty>=0), box_qty INTEGER NOT NULL CHECK(box_qty>=0),
 decision_id TEXT REFERENCES forecast_v2_decision_requests(decision_id),
 created_at TEXT NOT NULL, PRIMARY KEY(occurrence_id,revision),
 UNIQUE(occurrence_id,revision,grant_game_day,ii_qty,box_qty),
 CHECK(ii_qty+box_qty>0)
);
CREATE TABLE forecast_v2_grant_heads (
 occurrence_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL,
 grant_game_day TEXT NOT NULL, ii_qty INTEGER NOT NULL, box_qty INTEGER NOT NULL,
 UNIQUE(grant_game_day,ii_qty,box_qty),
 FOREIGN KEY(occurrence_id,revision,grant_game_day,ii_qty,box_qty)
 REFERENCES forecast_v2_grant_revisions(occurrence_id,revision,grant_game_day,ii_qty,box_qty)
);
CREATE TRIGGER forecast_v2_grant_head_cas BEFORE UPDATE ON forecast_v2_grant_heads
 WHEN NEW.occurrence_id<>OLD.occurrence_id OR NEW.revision<>OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'grant_revision_conflict'); END;
CREATE TABLE forecast_v2_grant_links (
 link_id TEXT PRIMARY KEY NOT NULL,
 occurrence_id TEXT NOT NULL REFERENCES forecast_v2_grant_heads(occurrence_id),
 observation_id TEXT REFERENCES forecast_v2_grant_observations(observation_id),
 legacy_grant_id TEXT,
 CHECK(observation_id IS NOT NULL OR legacy_grant_id IS NOT NULL),
 UNIQUE(occurrence_id,observation_id), UNIQUE(legacy_grant_id)
);
INSERT INTO schema_migrations(version,applied_at) VALUES(32,CURRENT_TIMESTAMP);
