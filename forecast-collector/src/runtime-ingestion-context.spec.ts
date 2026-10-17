import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import * as candidates from "./candidate";
import { enqueue, fixture, root, rows, run, sqlite } from "./test-ingestion-fixture";

it("does not reach the v4 builder before schema 27", async () => {
  sqlite.exec("DELETE FROM schema_migrations WHERE version >= 27");
  const builder = vi.spyOn(candidates, "buildForecastCandidate");
  try {
    await enqueue();
    const result = await run();
    expect(result.candidateCreated).toBe(false);
    expect(builder).not.toHaveBeenCalled();
    expect(rows("SELECT * FROM forecast_candidates")).toEqual([]);
    expect(rows("SELECT * FROM schedule_events").length).toBeGreaterThan(0);
  } finally {
    builder.mockRestore();
  }
});
it("binds a reopen review generation to its immutable judgment evidence", async () => {
  const payload = JSON.parse(
    readFileSync(new URL("fixtures/naver-detail-7877359.json", root), "utf8"),
  );
  await enqueue(payload);
  expect(
    (await run(vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload))))
      .candidateCreated,
  ).toBe(false);
  const joined = rows(`SELECT e.reason,e.content_hash,b.body_hash FROM source_manual_reviews r
    JOIN source_manual_review_bindings b ON b.review_id=r.review_id AND b.generation=r.generation
    JOIN source_judgment_evidence e ON e.source=r.source AND e.item_id=r.item_id AND e.content_hash=b.body_hash`);
  expect(joined).toHaveLength(1);
  expect(joined[0]).toMatchObject({
    reason: "reopen_without_suspension",
    content_hash: joined[0]?.["body_hash"],
  });
});

it.each(["5월8일", "05월8일", "5월08일", "05월08일"])(
  "resolves stored maintenance with date syntax %s",
  async (date) => {
    const payload = structuredClone(fixture);
    payload.content.feed.contents = `<!-- SE_DOC_HEADER_START --><div class="se-viewer">
      <p>솔로 레이드</p><p>진행 기간 - 5/8 점검 완료 후 ~ 5/15 4:59</p></div>`;
    sqlite
      .prepare(`INSERT INTO source_notice_revisions
      (source,item_id,source_revision,body_hash,revision_hash,semantic_hash,item_json,events_json,observed_at)
      VALUES('naver-board-48','padded-maintenance',1,?,?,?,?,'[]',?)`)
      .run(
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        JSON.stringify({
          normalizedText: `점검 일시 - ${date}(금) 11:00:00 ~ 15:00:00`,
          publishedAt: "2026-05-07T00:00:00Z",
        }),
        "2026-05-07T00:00:00Z",
      );
    await enqueue(payload);
    await run(async () => Response.json(payload));
    expect(rows("SELECT starts_at,manual_review FROM schedule_events")).toEqual([
      { starts_at: "2026-05-08T06:00:00.000Z", manual_review: 0 },
    ]);
  },
);
