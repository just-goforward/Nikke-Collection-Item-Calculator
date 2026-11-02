import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { executeTestSql } from "../../shared/testD1Sql";
import { listManualReviews, listSourceQueue } from "./source-history";
import schema from "./test-schema";

const reviewId = `mr-${"a".repeat(32)}`;

beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schema, applyD1Migrations);
  await env.FORECAST_DB.prepare(`INSERT INTO source_queue
    (source,item_id,url,title,published_at,official,status,attempts,first_seen_at,updated_at)
    VALUES('naver-board-48','100','https://game.naver.com/lounge/nikke/board/detail/100',
    'Archived notice','2000-01-01T00:00:00Z',1,'pending',2,
    '2000-01-01T00:00:00Z','2000-01-01T00:00:00Z')`).run();
  await env.FORECAST_DB.prepare(`INSERT INTO source_manual_reviews
    (review_id,source,item_id,generation,state,created_at,expires_at)
    VALUES(?,'naver-board-48','100',0,'pending',
    '2000-01-01T00:00:00Z','2000-01-02T00:00:00Z')`)
    .bind(reviewId)
    .run();
});

it("reads the archived queue without reprocessing or changing its attempt count", async () => {
  expect(await listSourceQueue(env.FORECAST_DB, 20)).toEqual([
    {
      source: "naver-board-48",
      itemId: "100",
      url: "https://game.naver.com/lounge/nikke/board/detail/100",
      title: "Archived notice",
      publishedAt: "2000-01-01T00:00:00Z",
      official: true,
      status: "pending",
      attempts: 2,
      errorCode: null,
    },
  ]);
  expect(await env.FORECAST_DB.prepare("SELECT attempts FROM source_queue").first()).toEqual({
    attempts: 2,
  });
});

it("projects expiration without rewriting persisted review history", async () => {
  expect(await listManualReviews(env.FORECAST_DB, { status: "pending", limit: 20 })).toEqual([]);
  expect(await listManualReviews(env.FORECAST_DB, { status: "expired", limit: 20 })).toEqual([
    {
      reviewId,
      source: "naver-board-48",
      itemId: "100",
      generation: 0,
      state: "expired",
      decision: null,
      actor: null,
      reason: null,
      createdAt: "2000-01-01T00:00:00Z",
      expiresAt: "2000-01-02T00:00:00Z",
      resolvedAt: null,
      sourceItem: {
        url: "https://game.naver.com/lounge/nikke/board/detail/100",
        title: "Archived notice",
        publishedAt: "2000-01-01T00:00:00Z",
        errorCode: null,
        queueStatus: "pending",
      },
    },
  ]);
  expect(await env.FORECAST_DB.prepare("SELECT state FROM source_manual_reviews").first()).toEqual({
    state: "pending",
  });
});

it("rejects unsafe historical source URLs", async () => {
  await env.FORECAST_DB.prepare("UPDATE source_queue SET url='https://attacker.invalid/'").run();
  await expect(
    listManualReviews(env.FORECAST_DB, { status: "expired", limit: 20 }),
  ).rejects.toThrow("manual_review_source_url_invalid");
});
