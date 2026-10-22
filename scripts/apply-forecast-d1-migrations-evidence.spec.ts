import { describe, expect, it } from "vitest";
import { sqliteRunner } from "./forecast-migration-test-fixtures.ts";
import { legacyDatabase } from "./forecast-migration-v27-fixtures.ts";

describe("Forecast migration SQL and restart behavior", () => {
  it("preserves v8 reviews and creates immutable v11 evidence bindings exactly once", () => {
    const db = legacyDatabase(7);
    db.exec(`INSERT INTO source_queue (source, item_id, url, title, published_at, official, status,
      first_seen_at, updated_at) VALUES ('naver-board-56', '1', 'https://example.test/1', 'test',
      '2026-09-01T00:00:00Z', 1, 'manual_review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');`);
    db.prepare(`INSERT INTO source_items VALUES ('naver-board-56', '1',
      'https://example.test/1', 'test', 'retained official body', '2026-09-01T00:00:00Z',
      ?, 0, 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run("a".repeat(64));
    const runner = sqliteRunner(db);
    expect(runner.run().applied).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
      32, 33, 34,
    ]);
    const reviews = db.prepare("SELECT * FROM source_manual_reviews").all();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      generation: 0,
      state: "pending",
      expires_at: "2026-09-15T00:00:00.000Z",
    });
    const bindings = db.prepare("SELECT * FROM source_manual_review_bindings").all();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      review_id: reviews[0]?.["review_id"],
      source_revision: 0,
      body_hash: "a".repeat(64),
      revision_hash: null,
      semantic_hash: null,
      generation: 0,
      review_token: expect.stringMatching(/^[0-9a-f]{64}$/),
      item_json: null,
    });
    expect(JSON.parse(String(bindings[0]?.["metadata_json"]))).toEqual({
      source: "naver-board-56",
      itemId: "1",
      url: "https://example.test/1",
      title: "test",
      publishedAt: "2026-09-01T00:00:00Z",
      official: 1,
    });
    expect(() => db.exec("UPDATE source_manual_review_bindings SET generation=1")).toThrow(
      /source_evidence_immutable/,
    );
    runner.run();
    expect(db.prepare("SELECT * FROM source_manual_reviews").all()).toEqual(reviews);
    expect(db.prepare("SELECT * FROM source_manual_review_bindings").all()).toEqual(bindings);
  });
});
