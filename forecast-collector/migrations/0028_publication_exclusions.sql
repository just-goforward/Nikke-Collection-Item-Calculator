CREATE TABLE publication_review_exclusions (
  review_id TEXT NOT NULL REFERENCES source_manual_review_bindings(review_id),
  context_hash TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  exclusion_json TEXT NOT NULL CHECK(json_valid(exclusion_json)),
  PRIMARY KEY(review_id,context_hash,block_index)
);
CREATE TRIGGER publication_review_exclusions_update BEFORE UPDATE ON publication_review_exclusions
BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER publication_review_exclusions_delete BEFORE DELETE ON publication_review_exclusions
BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
CREATE TRIGGER publication_review_exclusions_replace BEFORE INSERT ON publication_review_exclusions
WHEN EXISTS(SELECT 1 FROM publication_review_exclusions WHERE review_id=NEW.review_id AND context_hash=NEW.context_hash AND block_index=NEW.block_index)
BEGIN SELECT RAISE(ABORT,'source_evidence_immutable'); END;
INSERT INTO schema_migrations(version,applied_at) VALUES(28,CURRENT_TIMESTAMP);
