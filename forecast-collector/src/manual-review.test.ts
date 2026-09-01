import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import migrationSql from "../migrations/0008_manual_reviews_interactions_canary.sql?raw";
import schemaSql from "../schema.sql?raw";
import { decideManualReview, ensureManualReviewStatement, readManualReview } from "./manual-review";
import { processSourceQueue } from "./source-queue";
import type { CollectorEnv, NaverSourceKind } from "./types";

const testEnv: CollectorEnv = {
  FORECAST_DB: env.FORECAST_DB,
  ADMIN_RATE_LIMITER: env.ADMIN_RATE_LIMITER,
  ADMIN_TOKEN: env.ADMIN_TOKEN,
  ENVIRONMENT: "test",
  DEPLOY_SHA: env.DEPLOY_SHA,
  POLL_MODE: "both",
};

beforeEach(async () => {
  await reset();
  for (const statement of schemaSql
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    await testEnv.FORECAST_DB.prepare(statement).run();
  }
});

describe("manual review decisions", () => {
  it("migrates a v7 manual-review queue row with an ISO expiry", async () => {
    await reset();
    await testEnv.FORECAST_DB.prepare(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    ).run();
    await testEnv.FORECAST_DB.prepare(
      `CREATE TABLE source_queue (
         source TEXT NOT NULL, item_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
         published_at TEXT NOT NULL, official INTEGER NOT NULL, status TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, first_seen_at TEXT NOT NULL,
         updated_at TEXT NOT NULL, PRIMARY KEY (source, item_id)
       )`,
    ).run();
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO source_queue VALUES (
         'naver-board-56', '90', 'https://game.naver.com/lounge/nikke/board/detail/90',
         '공지 90', '2026-08-31T00:00:00.000Z', 1, 'manual_review', 3,
         'schedule_ambiguous', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z'
       )`,
    ).run();
    for (const statement of migrationSql
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      await testEnv.FORECAST_DB.prepare(statement).run();
    }

    const row = await testEnv.FORECAST_DB.prepare(
      `SELECT generation, state, expires_at FROM source_manual_reviews
       WHERE source = 'naver-board-56' AND item_id = '90'`,
    ).first<{ generation: number; state: string; expires_at: string }>();
    expect(row).toEqual({
      generation: 0,
      state: "pending",
      expires_at: "2026-09-14T00:00:00.000Z",
    });
    const version = await testEnv.FORECAST_DB.prepare(
      "SELECT version FROM schema_migrations WHERE version = 8",
    ).first<{ version: number }>();
    expect(version?.version).toBe(8);
  });

  it("requeues idempotently and creates a new review generation after another failure", async () => {
    const reviewId = await insertManualReview("100");
    const request = decision("requeue", "a");

    const first = await decideManualReview(testEnv.FORECAST_DB, "staging", reviewId, request, {
      nowMs: Date.now(),
    });
    const replay = await decideManualReview(testEnv.FORECAST_DB, "staging", reviewId, request, {
      nowMs: Date.now(),
    });

    expect(first).toMatchObject({ idempotent: false, candidateCreated: false });
    expect(replay).toMatchObject({ idempotent: true, candidateCreated: false });
    await expect(queue("100")).resolves.toMatchObject({
      status: "pending",
      attempts: 0,
      review_generation: 1,
      error_code: null,
    });
    await expect(alertState("100")).resolves.toBe("resolved");

    await processSourceQueue(testEnv.FORECAST_DB, {
      mode: "queue",
      results: [
        {
          source: "naver-board-56",
          itemId: "100",
          outcome: "manual_review",
          errorCode: "schedule_ambiguous",
        },
      ],
    });
    const pending = await testEnv.FORECAST_DB.prepare(
      `SELECT review_id, generation, state FROM source_manual_reviews
       WHERE source = 'naver-board-56' AND item_id = '100' ORDER BY generation`,
    ).all<{ review_id: string; generation: number; state: string }>();
    expect(pending.results).toHaveLength(2);
    expect(pending.results[1]).toMatchObject({ generation: 1, state: "pending" });

    await expect(
      decideManualReview(testEnv.FORECAST_DB, "staging", reviewId, {
        ...request,
        reason: "different payload",
      }),
    ).rejects.toThrow("manual_review_request_conflict");
  });

  it("marks an ignored item and resolves its operations alert", async () => {
    const reviewId = await insertManualReview("101");

    await decideManualReview(testEnv.FORECAST_DB, "staging", reviewId, decision("ignore", "b"));

    await expect(queue("101")).resolves.toMatchObject({ status: "ignored", attempts: 3 });
    await expect(readManualReview(testEnv.FORECAST_DB, reviewId)).resolves.toMatchObject({
      state: "resolved",
      decision: "ignore",
    });
    await expect(alertState("101")).resolves.toBe("resolved");
  });

  it("creates a verified manual event from official queue metadata when no body was stored", async () => {
    const reviewId = await insertManualReview("102");

    const result = await decideManualReview(testEnv.FORECAST_DB, "staging", reviewId, {
      ...decision("manual_event", "c"),
      event: {
        eventType: "cooperation",
        startsAtKst: "2026-09-03T05:00",
        endsAtKst: null,
        scheduleStatus: "confirmed",
      },
    });

    expect(result).toMatchObject({ idempotent: false, candidateCreated: false });
    await expect(queue("102")).resolves.toMatchObject({ status: "processed" });
    const item = await testEnv.FORECAST_DB.prepare(
      `SELECT structured, official, content_hash FROM source_items
       WHERE source = 'naver-board-56' AND item_id = '102'`,
    ).first<{ structured: number; official: number; content_hash: string }>();
    expect(item).toMatchObject({ structured: 0, official: 1 });
    expect(item?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const event = await testEnv.FORECAST_DB.prepare(
      `SELECT event_type, starts_at, ends_at, manual_review FROM schedule_events
       WHERE source = 'naver-board-56' AND source_item_id = '102'`,
    ).first<{
      event_type: string;
      starts_at: string;
      ends_at: string | null;
      manual_review: number;
    }>();
    expect(event).toEqual({
      event_type: "cooperation",
      starts_at: "2026-09-02T20:00:00.000Z",
      ends_at: null,
      manual_review: 0,
    });
  });

  it("expires a pending review without mutating its queue decision", async () => {
    const reviewId = await insertManualReview("103");
    await testEnv.FORECAST_DB.prepare(
      "UPDATE source_manual_reviews SET expires_at = ? WHERE review_id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", reviewId)
      .run();

    await expect(readManualReview(testEnv.FORECAST_DB, reviewId)).resolves.toMatchObject({
      state: "expired",
      decision: null,
    });
    await expect(queue("103")).resolves.toMatchObject({ status: "manual_review" });
    await expect(
      decideManualReview(testEnv.FORECAST_DB, "staging", reviewId, decision("ignore", "d")),
    ).rejects.toThrow("manual_review_not_pending");
  });
});

async function insertManualReview(itemId: string, source: NaverSourceKind = "naver-board-56") {
  const now = new Date().toISOString();
  await testEnv.FORECAST_DB.prepare(
    `INSERT INTO source_queue (
       source, item_id, url, title, published_at, official, status, attempts,
       review_generation, error_code, first_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, 'manual_review', 3, 0, 'schedule_ambiguous', ?, ?)`,
  )
    .bind(
      source,
      itemId,
      `https://game.naver.com/lounge/nikke/board/detail/${itemId}`,
      `공지 ${itemId}`,
      now,
      now,
      now,
    )
    .run();
  await (await ensureManualReviewStatement(testEnv.FORECAST_DB, source, itemId, now)).run();
  const review = await testEnv.FORECAST_DB.prepare(
    "SELECT review_id FROM source_manual_reviews WHERE source = ? AND item_id = ?",
  )
    .bind(source, itemId)
    .first<{ review_id: string }>();
  if (!review) throw new Error("Expected a manual review row.");
  await testEnv.FORECAST_DB.prepare(
    `INSERT INTO forecast_ops_alerts (
       alert_key, environment, severity, component, error_code, state, context_json,
       notify_after_count, occurrence_count, first_seen_at, last_seen_at, next_send_at
     ) VALUES (?, 'staging', 'warning', 'source-queue', 'source_item_manual_review',
       'open', '{}', 1, 1, ?, ?, ?)`,
  )
    .bind(`manual-review:staging:${source}:${itemId}`, now, now, now)
    .run();
  return review.review_id;
}

function decision(kind: "requeue" | "ignore" | "manual_event", suffix: string) {
  return {
    requestId: `mrq-${suffix.repeat(32)}`,
    decision: kind,
    reason: `test ${kind}`,
    runId: 123,
    event: null,
  };
}

function queue(itemId: string) {
  return testEnv.FORECAST_DB.prepare(
    `SELECT status, attempts, review_generation, error_code FROM source_queue
     WHERE source = 'naver-board-56' AND item_id = ?`,
  )
    .bind(itemId)
    .first<{
      status: string;
      attempts: number;
      review_generation: number;
      error_code: string | null;
    }>();
}

async function alertState(itemId: string) {
  const row = await testEnv.FORECAST_DB.prepare(
    `SELECT state FROM forecast_ops_alerts
     WHERE alert_key = 'manual-review:staging:naver-board-56:' || ?`,
  )
    .bind(itemId)
    .first<{ state: string }>();
  return row?.state;
}
