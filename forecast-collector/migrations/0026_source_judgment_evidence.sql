CREATE TABLE IF NOT EXISTS source_judgment_evidence (
  source TEXT NOT NULL CHECK (source IN ('naver-board-11','naver-board-48','naver-board-56')),
  item_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash)=64),
  context_hash TEXT NOT NULL CHECK (length(context_hash)=64),
  rule_version TEXT NOT NULL,
  block_index INTEGER NOT NULL CHECK (block_index>=0),
  judged_at TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('no_change','solo','schedule_change','manual_review','ignored')),
  reason TEXT,
  question TEXT NOT NULL,
  triggers_json TEXT NOT NULL CHECK (
    json_valid(triggers_json) AND json_type(triggers_json)='array'
    AND json_array_length(triggers_json)<=5
    AND (json_array_length(triggers_json)<1 OR (json_type(triggers_json,'$[0]')='text' AND length(json_extract(triggers_json,'$[0]'))<=200))
    AND (json_array_length(triggers_json)<2 OR (json_type(triggers_json,'$[1]')='text' AND length(json_extract(triggers_json,'$[1]'))<=200))
    AND (json_array_length(triggers_json)<3 OR (json_type(triggers_json,'$[2]')='text' AND length(json_extract(triggers_json,'$[2]'))<=200))
    AND (json_array_length(triggers_json)<4 OR (json_type(triggers_json,'$[3]')='text' AND length(json_extract(triggers_json,'$[3]'))<=200))
    AND (json_array_length(triggers_json)<5 OR (json_type(triggers_json,'$[4]')='text' AND length(json_extract(triggers_json,'$[4]'))<=200))
  ),
  block_excerpt TEXT NOT NULL CHECK (length(block_excerpt)<=1200),
  comparison_json TEXT NOT NULL CHECK (json_valid(comparison_json) AND json_type(comparison_json)='object'),
  PRIMARY KEY (source,item_id,content_hash,rule_version,block_index,context_hash)
);
CREATE TRIGGER IF NOT EXISTS source_judgment_evidence_update_immutable BEFORE UPDATE ON source_judgment_evidence BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_judgment_evidence_delete_immutable BEFORE DELETE ON source_judgment_evidence BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_judgment_evidence_replace_immutable BEFORE INSERT ON source_judgment_evidence WHEN EXISTS(SELECT 1 FROM source_judgment_evidence WHERE source=NEW.source AND item_id=NEW.item_id AND content_hash=NEW.content_hash AND rule_version=NEW.rule_version AND block_index=NEW.block_index AND context_hash=NEW.context_hash) BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;

INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(26,CURRENT_TIMESTAMP);
