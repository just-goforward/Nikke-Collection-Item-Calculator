-- LOCAL UNAPPLIED PROPOSAL, existing Stats D1 only, after 0002.
-- Back up original legacy aggregates before any separately approved application.
-- No calendar pins, raw expiry, exact private times, tokens, or runtime snapshot hashes.
CREATE TABLE outcome_public_slots (
  slot_id TEXT PRIMARY KEY NOT NULL,
  content_hash TEXT NOT NULL REFERENCES outcome_public_artifacts(content_hash) ON DELETE RESTRICT,
  normalized_digest TEXT NOT NULL,
  projection_policy TEXT NOT NULL,
  game_day TEXT NOT NULL,
  slot_start TEXT NOT NULL,
  slot_end TEXT NOT NULL CHECK(slot_end>slot_start),
  scope TEXT NOT NULL CHECK(scope='published_slot_releases'),
  projection_status TEXT NOT NULL CHECK(projection_status IN('available','unavailable')),
  unavailable_reason TEXT,
  unit TEXT,
  blue_numerator TEXT, blue_denominator TEXT,
  purple_numerator TEXT, purple_denominator TEXT,
  yellow_numerator TEXT, yellow_denominator TEXT,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  UNIQUE(content_hash,projection_policy,game_day,slot_start,slot_end),
  CHECK((projection_status='unavailable' AND unavailable_reason IS NOT NULL AND unit IS NULL
    AND blue_numerator IS NULL AND blue_denominator IS NULL
    AND purple_numerator IS NULL AND purple_denominator IS NULL
    AND yellow_numerator IS NULL AND yellow_denominator IS NULL)
    OR (projection_status='available' AND unavailable_reason IS NULL AND unit='pieces'
    AND blue_numerator IS NOT NULL AND blue_denominator IS NOT NULL
    AND purple_numerator IS NOT NULL AND purple_denominator IS NOT NULL
    AND yellow_numerator IS NOT NULL AND yellow_denominator IS NOT NULL))
);
CREATE INDEX outcome_public_slots_day ON outcome_public_slots(game_day,slot_id);
CREATE INDEX outcome_public_slots_publication_day ON outcome_public_slots(content_hash,game_day,slot_id);
CREATE TABLE outcome_public_laws (
  content_hash TEXT NOT NULL REFERENCES outcome_public_artifacts(content_hash) ON DELETE RESTRICT,
  law_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  model_version TEXT,
  law_json TEXT NOT NULL CHECK(json_valid(law_json)),
  PRIMARY KEY(content_hash,law_id)
);
CREATE TABLE outcome_public_releases (
  slot_id TEXT NOT NULL REFERENCES outcome_public_slots(slot_id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  schedule_status TEXT NOT NULL,
  available_at TEXT NOT NULL,
  expires_at TEXT,
  rule_id TEXT NOT NULL,
  cancelled INTEGER NOT NULL CHECK(cancelled IN(0,1)),
  modeled INTEGER NOT NULL CHECK(modeled IN(0,1)),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  PRIMARY KEY(slot_id,event_id)
);
CREATE TABLE outcome_public_release_laws (
  slot_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  law_id TEXT NOT NULL,
  count INTEGER NOT NULL CHECK(count>0),
  PRIMARY KEY(slot_id,event_id,law_id),
  FOREIGN KEY(slot_id,event_id) REFERENCES outcome_public_releases(slot_id,event_id) ON DELETE RESTRICT,
  FOREIGN KEY(content_hash,law_id) REFERENCES outcome_public_laws(content_hash,law_id) ON DELETE RESTRICT
);
CREATE TRIGGER outcome_public_slots_immutable BEFORE UPDATE ON outcome_public_slots
BEGIN SELECT RAISE(ABORT,'outcome_public_slot_immutable'); END;
CREATE TRIGGER outcome_public_slots_permanent BEFORE DELETE ON outcome_public_slots
BEGIN SELECT RAISE(ABORT,'outcome_public_slot_permanent'); END;
CREATE TRIGGER outcome_public_laws_immutable BEFORE UPDATE ON outcome_public_laws
BEGIN SELECT RAISE(ABORT,'outcome_public_law_immutable'); END;
CREATE TRIGGER outcome_public_laws_permanent BEFORE DELETE ON outcome_public_laws
BEGIN SELECT RAISE(ABORT,'outcome_public_law_permanent'); END;
CREATE TRIGGER outcome_public_releases_immutable BEFORE UPDATE ON outcome_public_releases
BEGIN SELECT RAISE(ABORT,'outcome_public_release_immutable'); END;
CREATE TRIGGER outcome_public_releases_permanent BEFORE DELETE ON outcome_public_releases
BEGIN SELECT RAISE(ABORT,'outcome_public_release_permanent'); END;
CREATE TRIGGER outcome_public_release_laws_immutable BEFORE UPDATE ON outcome_public_release_laws
BEGIN SELECT RAISE(ABORT,'outcome_public_release_law_immutable'); END;
CREATE TRIGGER outcome_public_release_laws_permanent BEFORE DELETE ON outcome_public_release_laws
BEGIN SELECT RAISE(ABORT,'outcome_public_release_law_permanent'); END;

CREATE TABLE outcome_effects (
  report_id TEXT PRIMARY KEY NOT NULL,
  initial_commit_digest TEXT NOT NULL CHECK(length(initial_commit_digest)=64),
  initial_claim TEXT NOT NULL,
  patch_claim TEXT,
  patch_revision INTEGER NOT NULL DEFAULT 0 CHECK(patch_revision BETWEEN 0 AND 2),
  raw_admitted INTEGER NOT NULL CHECK(raw_admitted IN(0,1)),
  attempt_applied INTEGER NOT NULL CHECK(attempt_applied IN(0,1)),
  legacy_settled INTEGER NOT NULL CHECK(legacy_settled IN(0,1)),
  legacy_settlement_digest TEXT,
  CHECK((legacy_settled=0 AND legacy_settlement_digest IS NULL) OR
    (legacy_settled=1 AND legacy_settlement_digest IS NOT NULL AND length(legacy_settlement_digest)=64))
);
CREATE TABLE outcome_facts (
  report_id TEXT PRIMARY KEY NOT NULL REFERENCES outcome_effects(report_id) ON DELETE RESTRICT,
  slot_id TEXT NOT NULL REFERENCES outcome_public_slots(slot_id) ON DELETE RESTRICT,
  producer_version TEXT NOT NULL,
  producer_code_hash TEXT NOT NULL CHECK(length(producer_code_hash)=64),
  holdings_blue INTEGER NOT NULL CHECK(holdings_blue>=0),
  holdings_purple INTEGER NOT NULL CHECK(holdings_purple>=0),
  holdings_yellow INTEGER NOT NULL CHECK(holdings_yellow>=0),
  recommended_current TEXT NOT NULL CHECK(recommended_current IN('use_blue','use_purple','use_yellow')),
  chosen_method TEXT NOT NULL CHECK(chosen_method IN('use_blue','use_purple','use_yellow')),
  recommended_uses INTEGER NOT NULL CHECK(recommended_uses BETWEEN 1 AND 100),
  wait_recommended INTEGER NOT NULL CHECK(wait_recommended IN(0,1))
);
CREATE INDEX outcome_facts_slot ON outcome_facts(slot_id,report_id);
CREATE TABLE outcome_results (
  report_id TEXT PRIMARY KEY NOT NULL REFERENCES outcome_facts(report_id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK(outcome IN('great','no_great')),
  attempt_count INTEGER CHECK(attempt_count BETWEEN 1 AND 100)
);
CREATE TRIGGER outcome_facts_immutable BEFORE UPDATE ON outcome_facts
BEGIN SELECT RAISE(ABORT,'outcome_fact_immutable'); END;
CREATE TRIGGER outcome_facts_permanent BEFORE DELETE ON outcome_facts
BEGIN SELECT RAISE(ABORT,'outcome_fact_permanent'); END;
CREATE TRIGGER outcome_results_once BEFORE UPDATE ON outcome_results
WHEN NEW.report_id!=OLD.report_id OR NEW.outcome!=OLD.outcome OR OLD.attempt_count IS NOT NULL
  OR NEW.attempt_count IS NULL
BEGIN SELECT RAISE(ABORT,'outcome_attempt_immutable'); END;
CREATE TRIGGER outcome_results_insert_bound BEFORE INSERT ON outcome_results
WHEN NEW.attempt_count IS NOT NULL AND
  (NEW.attempt_count>(SELECT recommended_uses FROM outcome_facts WHERE report_id=NEW.report_id) OR
   (NEW.outcome='no_great' AND NEW.attempt_count!=(SELECT recommended_uses FROM outcome_facts WHERE report_id=NEW.report_id)))
BEGIN SELECT RAISE(ABORT,'outcome_attempt_bound'); END;
CREATE TRIGGER outcome_results_update_bound BEFORE UPDATE ON outcome_results
WHEN NEW.attempt_count>(SELECT recommended_uses FROM outcome_facts WHERE report_id=NEW.report_id) OR
  (NEW.outcome='no_great' AND NEW.attempt_count!=(SELECT recommended_uses FROM outcome_facts WHERE report_id=NEW.report_id))
BEGIN SELECT RAISE(ABORT,'outcome_attempt_bound'); END;
CREATE TRIGGER outcome_results_permanent BEFORE DELETE ON outcome_results
BEGIN SELECT RAISE(ABORT,'outcome_result_permanent'); END;
CREATE TRIGGER outcome_effects_monotone BEFORE UPDATE ON outcome_effects
WHEN NEW.report_id!=OLD.report_id OR NEW.initial_commit_digest!=OLD.initial_commit_digest
  OR NEW.initial_claim!=OLD.initial_claim OR NEW.patch_revision<OLD.patch_revision
  OR NEW.raw_admitted<OLD.raw_admitted OR NEW.attempt_applied<OLD.attempt_applied
  OR NEW.legacy_settled<OLD.legacy_settled
  OR (OLD.legacy_settlement_digest IS NOT NULL AND NEW.legacy_settlement_digest IS NOT OLD.legacy_settlement_digest)
BEGIN SELECT RAISE(ABORT,'outcome_effect_immutable'); END;
CREATE TRIGGER outcome_effects_permanent BEFORE DELETE ON outcome_effects
BEGIN SELECT RAISE(ABORT,'outcome_effect_permanent'); END;

CREATE TABLE outcome_summary (
  producer_version TEXT NOT NULL, producer_code_hash TEXT NOT NULL,
  recommended_current TEXT NOT NULL, chosen_method TEXT NOT NULL, wait_recommended INTEGER NOT NULL,
  reports INTEGER NOT NULL CHECK(reports>0),
  great_reports INTEGER NOT NULL CHECK(great_reports>=0),
  no_great_reports INTEGER NOT NULL CHECK(no_great_reports>=0),
  known_attempt_reports INTEGER NOT NULL CHECK(known_attempt_reports>=0),
  attempts INTEGER NOT NULL CHECK(attempts>=0),
  known_great_reports INTEGER NOT NULL CHECK(known_great_reports>=0 AND known_great_reports<=attempts),
  PRIMARY KEY(producer_version,producer_code_hash,recommended_current,chosen_method,wait_recommended),
  CHECK(reports=great_reports+no_great_reports AND known_attempt_reports<=reports
    AND known_great_reports<=great_reports)
);
-- Operational clocks live only here; their deletion never permits report ID reuse.
CREATE TABLE outcome_controls (
  report_id TEXT PRIMARY KEY NOT NULL REFERENCES outcome_facts(report_id) ON DELETE RESTRICT,
  received_ms INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at=received_ms+86400000),
  legacy_attempt_count INTEGER CHECK(legacy_attempt_count BETWEEN 1 AND 100)
);
CREATE INDEX outcome_controls_expiry ON outcome_controls(expires_at,report_id);
CREATE TABLE outcome_receipts (
  report_id TEXT PRIMARY KEY NOT NULL REFERENCES outcome_facts(report_id) ON DELETE RESTRICT,
  received_ms INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at=received_ms+1209600000)
);
CREATE INDEX outcome_receipts_expiry ON outcome_receipts(expires_at,report_id);
CREATE TABLE outcome_budget (
  day TEXT PRIMARY KEY NOT NULL, attempts INTEGER NOT NULL CHECK(attempts>0), expires_at INTEGER NOT NULL
);
CREATE INDEX outcome_budget_expiry ON outcome_budget(expires_at,day);
CREATE TABLE outcome_maintenance (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_success_ms INTEGER
);
INSERT INTO outcome_maintenance(singleton,last_success_ms) VALUES(1,NULL);
