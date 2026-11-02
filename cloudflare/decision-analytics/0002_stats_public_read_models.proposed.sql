-- LOCAL PROPOSAL ONLY. Never executed against an existing database by this change.
-- Apply to the existing Stats D1 only, with separately approved backup/migration work.
-- These summaries derive from the preserved legacy aggregates, NOT minimal new facts.
-- The Forecast DB and its calendar retention are not modified.

-- Capture-time assertion inside the atomic file, not a separate readiness snapshot.
-- This checks installation headroom only; it does not enforce future numeric policy.
CREATE TABLE stats_public_0002_validation_guard (
  ok INTEGER NOT NULL CHECK(ok=1)
);
WITH
legacy_source AS MATERIALIZED (
  SELECT NULL AS date_key,grade,level,kit,events,attempts,great_successes,
    CASE WHEN typeof(grade)='text' AND typeof(level)='integer' AND typeof(kit)='text'
      AND typeof(events)='integer' AND typeof(attempts)='integer'
      AND typeof(great_successes)='integer'
    THEN CASE WHEN events>=0 AND attempts>=0
      AND great_successes>=0 AND great_successes<=attempts THEN 1 ELSE 0 END
    ELSE 0 END AS valid
  FROM event_aggregates LIMIT 10001
),
current_source AS MATERIALIZED (
  SELECT date_key,grade,level,kit,events,attempts,great_successes,
    CASE WHEN typeof(date_key)='text' AND typeof(grade)='text'
      AND typeof(level)='integer' AND typeof(kit)='text'
      AND typeof(events)='integer' AND typeof(attempts)='integer'
      AND typeof(great_successes)='integer'
    THEN CASE WHEN events>=0 AND attempts>=0
      AND great_successes>=0 AND great_successes<=attempts THEN 1 ELSE 0 END
    ELSE 0 END AS valid
  FROM event_aggregates_game_day LIMIT 10001
),
inputs AS MATERIALIZED (
  SELECT 'legacy' AS source,* FROM legacy_source
  UNION ALL
  SELECT 'current' AS source,* FROM current_source
),
gate AS MATERIALIZED (
  SELECT CASE WHEN COUNT(CASE WHEN source='legacy' THEN 1 END)<=10000
    AND COUNT(CASE WHEN source='current' THEN 1 END)<=10000
    THEN 1 ELSE 0 END AS input_complete,
    COALESCE(MIN(valid),1) AS source_valid
  FROM inputs
),
eligible AS MATERIALIZED (
  SELECT i.* FROM inputs i CROSS JOIN gate g
  WHERE g.input_complete=1 AND g.source_valid=1
),
grouped AS MATERIALIZED (
  SELECT SUM(events) AS se,SUM(attempts) AS sa,SUM(great_successes) AS sg,
    MAX(CASE WHEN source='current' THEN events ELSE 0 END) AS me,
    MAX(CASE WHEN source='current' THEN attempts ELSE 0 END) AS ma,
    MAX(CASE WHEN source='current' THEN great_successes ELSE 0 END) AS mg
  FROM eligible GROUP BY grade,level,kit
  UNION ALL
  SELECT SUM(events),SUM(attempts),SUM(great_successes),
    MAX(events),MAX(attempts),MAX(great_successes)
  FROM eligible WHERE source='current' GROUP BY date_key
)
INSERT INTO stats_public_0002_validation_guard(ok)
SELECT CASE WHEN g.input_complete=1 AND g.source_valid=1 AND NOT EXISTS (
  SELECT 1 FROM grouped
  WHERE CASE WHEN typeof(se)='integer' AND typeof(sa)='integer' AND typeof(sg)='integer'
    AND typeof(me)='integer' AND typeof(ma)='integer' AND typeof(mg)='integer'
  THEN CASE WHEN se>=0 AND sa>=0 AND sg>=0 AND sg<=sa
    AND se<=9223372036854775807-me-1
    AND sa<=9223372036854775807-ma-100
    AND sg<=9223372036854775807-mg-1
    THEN 1 ELSE 0 END
  ELSE 0 END=0
) THEN 1 ELSE 0 END FROM gate g;

CREATE TABLE stats_public_totals (
  grade TEXT NOT NULL,
  level INTEGER NOT NULL,
  kit TEXT NOT NULL,
  events INTEGER NOT NULL CHECK(events>=0),
  attempts INTEGER NOT NULL CHECK(attempts>=0),
  great_successes INTEGER NOT NULL CHECK(great_successes>=0 AND great_successes<=attempts),
  PRIMARY KEY(grade,level,kit)
);
CREATE TABLE stats_public_game_day (
  date_key TEXT PRIMARY KEY NOT NULL,
  events INTEGER NOT NULL CHECK(events>=0),
  attempts INTEGER NOT NULL CHECK(attempts>=0),
  great_successes INTEGER NOT NULL CHECK(great_successes>=0 AND great_successes<=attempts)
);

INSERT INTO stats_public_totals(grade,level,kit,events,attempts,great_successes)
SELECT grade,level,kit,SUM(events),SUM(attempts),SUM(great_successes)
FROM (
  SELECT grade,level,kit,events,attempts,great_successes FROM event_aggregates
  UNION ALL
  SELECT grade,level,kit,events,attempts,great_successes FROM event_aggregates_game_day
) GROUP BY grade,level,kit;
INSERT INTO stats_public_game_day(date_key,events,attempts,great_successes)
SELECT date_key,SUM(events),SUM(attempts),SUM(great_successes)
FROM event_aggregates_game_day GROUP BY date_key;

-- Updates use deltas so current ON CONFLICT settlement stays in the same transaction.
-- Identity changes are forbidden on the source aggregates: their public dimensions
-- are part of their existing primary keys and no operational writer changes them.
CREATE TRIGGER stats_public_legacy_identity BEFORE UPDATE ON event_aggregates
WHEN NEW.grade!=OLD.grade OR NEW.level!=OLD.level OR NEW.kit!=OLD.kit
BEGIN SELECT RAISE(ABORT,'stats_public_identity_immutable'); END;
CREATE TRIGGER stats_public_current_identity BEFORE UPDATE ON event_aggregates_game_day
WHEN NEW.grade!=OLD.grade OR NEW.level!=OLD.level OR NEW.kit!=OLD.kit OR NEW.date_key!=OLD.date_key
BEGIN SELECT RAISE(ABORT,'stats_public_identity_immutable'); END;

CREATE TRIGGER stats_public_legacy_insert AFTER INSERT ON event_aggregates
BEGIN
  INSERT INTO stats_public_totals(grade,level,kit,events,attempts,great_successes)
  VALUES(NEW.grade,NEW.level,NEW.kit,NEW.events,NEW.attempts,NEW.great_successes)
  ON CONFLICT(grade,level,kit) DO UPDATE SET
    events=events+excluded.events,attempts=attempts+excluded.attempts,
    great_successes=great_successes+excluded.great_successes;
END;
CREATE TRIGGER stats_public_legacy_update AFTER UPDATE ON event_aggregates
BEGIN
  UPDATE stats_public_totals SET events=events+NEW.events-OLD.events,
    attempts=attempts+NEW.attempts-OLD.attempts,
    great_successes=great_successes+NEW.great_successes-OLD.great_successes
  WHERE grade=NEW.grade AND level=NEW.level AND kit=NEW.kit;
END;
CREATE TRIGGER stats_public_legacy_delete AFTER DELETE ON event_aggregates
BEGIN
  UPDATE stats_public_totals SET events=events-OLD.events,attempts=attempts-OLD.attempts,
    great_successes=great_successes-OLD.great_successes
  WHERE grade=OLD.grade AND level=OLD.level AND kit=OLD.kit;
  DELETE FROM stats_public_totals WHERE grade=OLD.grade AND level=OLD.level AND kit=OLD.kit
    AND events=0 AND attempts=0 AND great_successes=0;
END;
CREATE TRIGGER stats_public_current_insert AFTER INSERT ON event_aggregates_game_day
BEGIN
  SELECT CASE WHEN typeof(NEW.events)='integer' AND typeof(NEW.attempts)='integer'
    AND typeof(NEW.great_successes)='integer'
  THEN CASE WHEN NEW.events>=0 AND NEW.attempts>=0
    AND NEW.great_successes>=0 AND NEW.great_successes<=NEW.attempts
    THEN 1 ELSE RAISE(ABORT,'stats_public_source_counter_invalid') END
  ELSE RAISE(ABORT,'stats_public_source_counter_invalid') END;
  -- Missing targets are initialization only under the approved writer invariant.
  SELECT COALESCE((
    SELECT CASE WHEN typeof(events)='integer' AND typeof(attempts)='integer'
      AND typeof(great_successes)='integer'
    THEN CASE WHEN events>=0 AND attempts>=0 AND great_successes>=0 AND great_successes<=attempts
      THEN CASE WHEN events<=9223372036854775807-NEW.events
        AND attempts<=9223372036854775807-NEW.attempts
        AND great_successes<=9223372036854775807-NEW.great_successes
        THEN 1 ELSE RAISE(ABORT,'stats_public_numeric_limit') END
      ELSE RAISE(ABORT,'stats_public_summary_counter_invalid') END
    ELSE RAISE(ABORT,'stats_public_summary_counter_invalid') END
    FROM stats_public_totals WHERE grade=NEW.grade AND level=NEW.level AND kit=NEW.kit
  ),1);
  SELECT COALESCE((
    SELECT CASE WHEN typeof(events)='integer' AND typeof(attempts)='integer'
      AND typeof(great_successes)='integer'
    THEN CASE WHEN events>=0 AND attempts>=0 AND great_successes>=0 AND great_successes<=attempts
      THEN CASE WHEN events<=9223372036854775807-NEW.events
        AND attempts<=9223372036854775807-NEW.attempts
        AND great_successes<=9223372036854775807-NEW.great_successes
        THEN 1 ELSE RAISE(ABORT,'stats_public_numeric_limit') END
      ELSE RAISE(ABORT,'stats_public_summary_counter_invalid') END
    ELSE RAISE(ABORT,'stats_public_summary_counter_invalid') END
    FROM stats_public_game_day WHERE date_key=NEW.date_key
  ),1);
  INSERT INTO stats_public_totals(grade,level,kit,events,attempts,great_successes)
  VALUES(NEW.grade,NEW.level,NEW.kit,NEW.events,NEW.attempts,NEW.great_successes)
  ON CONFLICT(grade,level,kit) DO UPDATE SET
    events=events+excluded.events,attempts=attempts+excluded.attempts,
    great_successes=great_successes+excluded.great_successes;
  INSERT INTO stats_public_game_day(date_key,events,attempts,great_successes)
  VALUES(NEW.date_key,NEW.events,NEW.attempts,NEW.great_successes)
  ON CONFLICT(date_key) DO UPDATE SET
    events=events+excluded.events,attempts=attempts+excluded.attempts,
    great_successes=great_successes+excluded.great_successes;
END;
CREATE TRIGGER stats_public_current_update AFTER UPDATE ON event_aggregates_game_day
BEGIN
  SELECT CASE WHEN typeof(NEW.events)='integer' AND typeof(NEW.attempts)='integer'
    AND typeof(NEW.great_successes)='integer' AND typeof(OLD.events)='integer'
    AND typeof(OLD.attempts)='integer' AND typeof(OLD.great_successes)='integer'
  THEN CASE WHEN NEW.events>=0 AND NEW.attempts>=0
    AND NEW.great_successes>=0 AND NEW.great_successes<=NEW.attempts
    AND OLD.events>=0 AND OLD.attempts>=0
    AND OLD.great_successes>=0 AND OLD.great_successes<=OLD.attempts
    THEN 1 ELSE RAISE(ABORT,'stats_public_source_counter_invalid') END
  ELSE RAISE(ABORT,'stats_public_source_counter_invalid') END;
  SELECT COALESCE((
    SELECT CASE WHEN typeof(events)='integer' AND typeof(attempts)='integer'
      AND typeof(great_successes)='integer'
    THEN CASE WHEN events>=0 AND attempts>=0 AND great_successes>=0 AND great_successes<=attempts
      THEN CASE WHEN events<=9223372036854775807-NEW.events
        AND attempts<=9223372036854775807-NEW.attempts
        AND great_successes<=9223372036854775807-NEW.great_successes
        THEN 1 ELSE RAISE(ABORT,'stats_public_numeric_limit') END
      ELSE RAISE(ABORT,'stats_public_summary_counter_invalid') END
    ELSE RAISE(ABORT,'stats_public_summary_counter_invalid') END
    FROM stats_public_totals WHERE grade=NEW.grade AND level=NEW.level AND kit=NEW.kit
  ),RAISE(ABORT,'stats_public_summary_missing'));
  SELECT COALESCE((
    SELECT CASE WHEN typeof(events)='integer' AND typeof(attempts)='integer'
      AND typeof(great_successes)='integer'
    THEN CASE WHEN events>=0 AND attempts>=0 AND great_successes>=0 AND great_successes<=attempts
      THEN CASE WHEN events<=9223372036854775807-NEW.events
        AND attempts<=9223372036854775807-NEW.attempts
        AND great_successes<=9223372036854775807-NEW.great_successes
        THEN 1 ELSE RAISE(ABORT,'stats_public_numeric_limit') END
      ELSE RAISE(ABORT,'stats_public_summary_counter_invalid') END
    ELSE RAISE(ABORT,'stats_public_summary_counter_invalid') END
    FROM stats_public_game_day WHERE date_key=NEW.date_key
  ),RAISE(ABORT,'stats_public_summary_missing'));
  UPDATE stats_public_totals SET events=events+NEW.events-OLD.events,
    attempts=attempts+NEW.attempts-OLD.attempts,
    great_successes=great_successes+NEW.great_successes-OLD.great_successes
  WHERE grade=NEW.grade AND level=NEW.level AND kit=NEW.kit;
  UPDATE stats_public_game_day SET events=events+NEW.events-OLD.events,
    attempts=attempts+NEW.attempts-OLD.attempts,
    great_successes=great_successes+NEW.great_successes-OLD.great_successes
  WHERE date_key=NEW.date_key;
END;
CREATE TRIGGER stats_public_current_delete AFTER DELETE ON event_aggregates_game_day
BEGIN
  UPDATE stats_public_totals SET events=events-OLD.events,attempts=attempts-OLD.attempts,
    great_successes=great_successes-OLD.great_successes
  WHERE grade=OLD.grade AND level=OLD.level AND kit=OLD.kit;
  DELETE FROM stats_public_totals WHERE grade=OLD.grade AND level=OLD.level AND kit=OLD.kit
    AND events=0 AND attempts=0 AND great_successes=0;
  UPDATE stats_public_game_day SET events=events-OLD.events,attempts=attempts-OLD.attempts,
    great_successes=great_successes-OLD.great_successes WHERE date_key=OLD.date_key;
  DELETE FROM stats_public_game_day WHERE date_key=OLD.date_key
    AND events=0 AND attempts=0 AND great_successes=0;
END;

CREATE TABLE outcome_public_artifacts (
  content_hash TEXT PRIMARY KEY NOT NULL
    CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  candidate_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN('staging','production')),
  key_id TEXT NOT NULL,
  pointer_statement TEXT NOT NULL CHECK(json_valid(pointer_statement)),
  pointer_signature TEXT NOT NULL,
  authorization_statement TEXT NOT NULL CHECK(json_valid(authorization_statement)),
  authorization_signature TEXT NOT NULL,
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
  CHECK(json_extract(pointer_statement,'$.mode')='active'),
  CHECK(json_extract(pointer_statement,'$.contentHash')=content_hash),
  CHECK(json_extract(pointer_statement,'$.candidateId')=candidate_id),
  CHECK(json_extract(pointer_statement,'$.environment')=environment),
  CHECK(json_extract(pointer_statement,'$.keyId')=key_id),
  CHECK(json_extract(authorization_statement,'$.contentHash')=content_hash),
  CHECK(json_extract(authorization_statement,'$.candidateId')=candidate_id),
  CHECK(json_extract(authorization_statement,'$.environment')=environment),
  CHECK(json_extract(authorization_statement,'$.keyId')=key_id),
  CHECK(json_extract(candidate_json,'$.candidateId')=candidate_id)
);
CREATE TRIGGER outcome_public_artifacts_immutable BEFORE UPDATE ON outcome_public_artifacts
BEGIN SELECT RAISE(ABORT,'outcome_public_artifact_immutable'); END;
CREATE TRIGGER outcome_public_artifacts_permanent BEFORE DELETE ON outcome_public_artifacts
BEGIN SELECT RAISE(ABORT,'outcome_public_artifact_permanent'); END;

DROP TABLE stats_public_0002_validation_guard;
