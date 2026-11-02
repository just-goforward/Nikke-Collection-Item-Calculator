-- Additive monitoring ledger. No legacy cursors are translated or advanced.
CREATE TABLE forecast_v2_monitors (
  stream_id TEXT PRIMARY KEY NOT NULL,
  board_id INTEGER NOT NULL CHECK(board_id IN (11,48,56)),
  keyword TEXT,
  search_option TEXT NOT NULL CHECK(search_option IN ('COMMUNITY_FEED_TITLE','COMMUNITY_FEED_TITLE_CONTENT','BOARD_LIST')),
  interval_seconds INTEGER NOT NULL CHECK(interval_seconds>0),
  on_demand INTEGER NOT NULL DEFAULT 0 CHECK(on_demand IN (0,1)),
  edit_horizon_days INTEGER NOT NULL DEFAULT 14 CHECK(edit_horizon_days>0),
  CHECK((search_option='BOARD_LIST')=(keyword IS NULL))
);
INSERT INTO forecast_v2_monitors(stream_id,board_id,keyword,search_option,interval_seconds,on_demand) VALUES
 ('A',11,'관리 키트','COMMUNITY_FEED_TITLE_CONTENT',3600,0),
 ('B',11,'솔로 레이드','COMMUNITY_FEED_TITLE',3600,0),
 ('C-open',56,'솔로 레이드 오픈','COMMUNITY_FEED_TITLE_CONTENT',3600,0),
 ('C-reopen',56,'솔로 레이드 재오픈','COMMUNITY_FEED_TITLE_CONTENT',3600,0),
 ('D',56,'콜라보','COMMUNITY_FEED_TITLE_CONTENT',3600,0),
 ('E',48,'솔로 레이드 시즌','COMMUNITY_FEED_TITLE_CONTENT',3600,1),
 ('F',48,'관리 키트','COMMUNITY_FEED_TITLE_CONTENT',3600,0),
 ('G',48,NULL,'BOARD_LIST',1800,0);
CREATE TABLE forecast_v2_monitor_state (
  stream_id TEXT PRIMARY KEY NOT NULL REFERENCES forecast_v2_monitors(stream_id),
  committed_created_at TEXT,
  committed_feed_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(committed_feed_ids_json) AND json_type(committed_feed_ids_json)='array'),
  continuation_cursor INTEGER NOT NULL DEFAULT 0 CHECK(continuation_cursor>=0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  consecutive_holds INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_holds>=0),
  edit_scan_cursor INTEGER NOT NULL DEFAULT 0 CHECK(edit_scan_cursor>=0),
  edit_scan_cutoff TEXT,
  edit_scan_completed_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL))
);
INSERT INTO forecast_v2_monitor_state(stream_id,updated_at)
 SELECT stream_id,CURRENT_TIMESTAMP FROM forecast_v2_monitors;
CREATE TABLE forecast_v2_monitor_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  stream_id TEXT NOT NULL REFERENCES forecast_v2_monitors(stream_id),
  generation INTEGER NOT NULL CHECK(generation>=0),
  kind TEXT NOT NULL CHECK(kind IN ('new','edit','extended')),
  status TEXT NOT NULL CHECK(status IN ('running','held','completed','failed')),
  continuation_cursor INTEGER NOT NULL DEFAULT 0 CHECK(continuation_cursor>=0),
  pages_used INTEGER NOT NULL DEFAULT 0 CHECK(pages_used>=0),
  page_limit INTEGER NOT NULL DEFAULT 4 CHECK(page_limit>0),
  review_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  CHECK(pages_used<=page_limit),
  UNIQUE(stream_id,generation,kind)
);
CREATE TABLE forecast_v2_search_hits (
  run_id TEXT NOT NULL REFERENCES forecast_v2_monitor_runs(run_id),
  feed_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  PRIMARY KEY(run_id,feed_id)
);
CREATE TABLE forecast_v2_post_versions (
  version_id TEXT PRIMARY KEY NOT NULL,
  feed_id TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  board_id INTEGER NOT NULL CHECK(board_id IN (11,48,56)),
  created_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  body_text TEXT NOT NULL,
  UNIQUE(feed_id,updated_date,content_hash)
);
CREATE TABLE forecast_v2_rules_queue (
  version_id TEXT NOT NULL REFERENCES forecast_v2_post_versions(version_id),
  stream_id TEXT NOT NULL REFERENCES forecast_v2_monitors(stream_id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(version_id,stream_id)
);
CREATE INDEX forecast_v2_rules_queue_pending
  ON forecast_v2_rules_queue(status,attempts,created_at);
CREATE INDEX forecast_v2_search_hits_version
  ON forecast_v2_search_hits(feed_id,updated_date);
-- Triggers enqueue atomically with either arrival order, including a known body
-- discovered later by a different monitor.
CREATE TRIGGER forecast_v2_rules_enqueue_version AFTER INSERT ON forecast_v2_post_versions
BEGIN
  INSERT OR IGNORE INTO forecast_v2_rules_queue(version_id,stream_id,created_at)
    SELECT NEW.version_id,r.stream_id,NEW.created_at
    FROM forecast_v2_search_hits h JOIN forecast_v2_monitor_runs r ON r.run_id=h.run_id
    WHERE h.feed_id=NEW.feed_id AND h.updated_date=NEW.updated_date;
END;
CREATE TRIGGER forecast_v2_rules_enqueue_hit AFTER INSERT ON forecast_v2_search_hits
BEGIN
  INSERT OR IGNORE INTO forecast_v2_rules_queue(version_id,stream_id,created_at)
    SELECT v.version_id,r.stream_id,v.created_at FROM forecast_v2_post_versions v
    JOIN forecast_v2_monitor_runs r ON r.run_id=NEW.run_id
    WHERE v.feed_id=NEW.feed_id AND v.updated_date=NEW.updated_date;
END;
CREATE TABLE forecast_v2_fetch_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES forecast_v2_monitor_runs(run_id),
  feed_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('metadata','detail')),
  game_day TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('reserved','success','failure','held')),
  error_code TEXT,
  next_attempt_at TEXT
);
CREATE TABLE forecast_v2_request_budgets (
  game_day TEXT PRIMARY KEY NOT NULL,
  metadata_used INTEGER NOT NULL DEFAULT 0 CHECK(metadata_used>=0 AND metadata_used<=metadata_limit),
  detail_used INTEGER NOT NULL DEFAULT 0 CHECK(detail_used>=0 AND detail_used<=detail_limit),
  metadata_limit INTEGER NOT NULL DEFAULT 240 CHECK(metadata_limit>=0),
  detail_limit INTEGER NOT NULL DEFAULT 48 CHECK(detail_limit>=0)
);
CREATE TABLE forecast_v2_legacy_links (
  import_key TEXT PRIMARY KEY NOT NULL,
  legacy_table TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  version_id TEXT REFERENCES forecast_v2_post_versions(version_id),
  disposition TEXT NOT NULL CHECK(disposition IN ('retained','migrated','resolved','disabled')),
  created_at TEXT NOT NULL,
  UNIQUE(legacy_table,legacy_id)
);
INSERT INTO schema_migrations(version,applied_at) VALUES(30,CURRENT_TIMESTAMP);
