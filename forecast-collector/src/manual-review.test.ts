import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTestSql } from "../../shared/testD1Sql";
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

const deniedFetch = vi.fn(async () => {
  throw new Error("Unexpected outbound fetch in manual review tests.");
});

beforeEach(async () => {
  deniedFetch.mockClear();
  vi.stubGlobal("fetch", deniedFetch);
  await reset();
  await executeTestSql(testEnv.FORECAST_DB, schemaSql, applyD1Migrations);
});

afterEach(() => {
  try {
    expect(deniedFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
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
    await executeTestSql(testEnv.FORECAST_DB, migrationSql, applyD1Migrations);

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

describe("manual review winning races", () => {
  it.each(["ignore", "requeue", "manual_event"] as const)(
    "does not persist a losing manual event after a %s winner",
    async (winnerKind) => {
      const nowMs = Date.now();
      const publishedAt = new Date(nowMs).toISOString();
      const reviewId = await insertManualReview("110", "naver-board-56", publishedAt);
      const loser = manualEventRequest("a", nowMs);
      const winnerEvent = manualEventRequest("b", nowMs, 2);
      const winner = winnerKind === "manual_event" ? winnerEvent : decision(winnerKind, "b");
      let winnerRows: Awaited<ReturnType<typeof decisionRows>> | undefined;
      const losingDb = interleavedDatabase(async () => {
        const result = await decideManualReview(testEnv.FORECAST_DB, "staging", reviewId, winner, {
          nowMs,
          actor: "winner",
        });
        expect(result).toMatchObject({
          idempotent: false,
          candidateCreated: winnerKind === "manual_event",
          review: { state: "resolved", decision: winnerKind, actor: "winner" },
        });
        if (winnerKind === "requeue") {
          await processSourceQueue(testEnv.FORECAST_DB, {
            mode: "queue",
            results: [
              {
                source: "naver-board-56",
                itemId: "110",
                outcome: "manual_review",
                errorCode: "schedule_ambiguous",
              },
            ],
          });
          await testEnv.FORECAST_DB.prepare(
            `UPDATE forecast_ops_alerts SET state = 'open', resolved_at = NULL
             WHERE alert_key = 'manual-review:staging:naver-board-56:110'`,
          ).run();
          await expect(queue("110")).resolves.toMatchObject({
            status: "manual_review",
            review_generation: 1,
          });
          const reviews = await testEnv.FORECAST_DB.prepare(
            `SELECT generation, state FROM source_manual_reviews
             WHERE item_id = '110' ORDER BY generation`,
          ).all();
          expect(reviews.results).toEqual([
            { generation: 0, state: "resolved" },
            { generation: 1, state: "pending" },
          ]);
        } else {
          await expect(queue("110")).resolves.toMatchObject({
            status: winnerKind === "ignore" ? "ignored" : "processed",
          });
          await expect(alertState("110")).resolves.toBe("resolved");
        }
        if (winnerKind === "manual_event") {
          await expectManualEventWinner("110", publishedAt, winnerEvent.event, nowMs);
        }
        winnerRows = await decisionRows();
      });

      await expect(
        decideManualReview(losingDb, "staging", reviewId, loser, {
          nowMs: nowMs + 60_000,
          actor: "loser",
        }),
      ).rejects.toThrow("manual_review_decision_race");
      expect(winnerRows).toBeDefined();
      expect(await decisionRows()).toEqual(winnerRows);
    },
  );

  it("keeps a same-request loser write-free, then permits an ordinary replay", async () => {
    const nowMs = Date.now();
    const publishedAt = new Date(nowMs).toISOString();
    const reviewId = await insertManualReview("111", "naver-board-56", publishedAt);
    const request = manualEventRequest("c", nowMs);
    let winnerRows: Awaited<ReturnType<typeof decisionRows>> | undefined;
    const losingDb = interleavedDatabase(async () => {
      const winner = await decideManualReview(testEnv.FORECAST_DB, "staging", reviewId, request, {
        nowMs,
        actor: "winner",
      });
      expect(winner).toMatchObject({
        idempotent: false,
        candidateCreated: true,
        review: { actor: "winner", decision: "manual_event" },
      });
      await expectManualEventWinner("111", publishedAt, request.event, nowMs);
      await testEnv.FORECAST_DB.prepare(
        `UPDATE forecast_ops_alerts SET state = 'open', resolved_at = NULL
         WHERE alert_key = 'manual-review:staging:naver-board-56:111'`,
      ).run();
      winnerRows = await decisionRows();
    });

    await expect(
      decideManualReview(losingDb, "staging", reviewId, request, {
        nowMs: nowMs + 60_000,
        actor: "loser",
      }),
    ).rejects.toThrow("manual_review_decision_race");
    expect(winnerRows).toBeDefined();
    expect(await decisionRows()).toEqual(winnerRows);
    await expect(
      decideManualReview(testEnv.FORECAST_DB, "staging", reviewId, request, {
        nowMs,
        actor: "replay",
      }),
    ).resolves.toMatchObject({
      idempotent: true,
      candidateCreated: false,
      review: { actor: "winner" },
    });
    expect(await decisionRows()).toEqual(winnerRows);
  });
});

describe("manual review stale decisions", () => {
  it.each(["queue_status", "queue_generation", "review_expired"] as const)(
    "does not write a stale manual event after %s changes",
    async (change) => {
      const reviewId = await insertManualReview("112");
      const nowMs = Date.now();
      let changedRows: Awaited<ReturnType<typeof decisionRows>> | undefined;
      const losingDb = interleavedDatabase(async () => {
        if (change === "review_expired") {
          await testEnv.FORECAST_DB.prepare(
            "UPDATE source_manual_reviews SET expires_at = ? WHERE review_id = ?",
          )
            .bind("2020-01-01T00:00:00.000Z", reviewId)
            .run();
          await expect(readManualReview(testEnv.FORECAST_DB, reviewId)).resolves.toMatchObject({
            state: "expired",
            decision: null,
          });
        } else {
          await testEnv.FORECAST_DB.prepare(
            change === "queue_status"
              ? "UPDATE source_queue SET status = 'pending' WHERE item_id = '112'"
              : "UPDATE source_queue SET review_generation = 1 WHERE item_id = '112'",
          ).run();
        }
        await expect(alertState("112")).resolves.toBe("open");
        changedRows = await decisionRows();
      });

      await expect(
        decideManualReview(losingDb, "staging", reviewId, manualEventRequest("d", nowMs), {
          nowMs,
        }),
      ).rejects.toThrow("manual_review_decision_race");
      expect(changedRows).toBeDefined();
      expect(await decisionRows()).toEqual(changedRows);
    },
  );

  it.each(["requeue", "ignore"] as const)(
    "does not let a losing %s request alter the winner",
    async (loserKind) => {
      const reviewId = await insertManualReview("113");
      const nowMs = Date.now();
      let winnerRows: Awaited<ReturnType<typeof decisionRows>> | undefined;
      const losingDb = interleavedDatabase(async () => {
        await decideManualReview(
          testEnv.FORECAST_DB,
          "staging",
          reviewId,
          decision("ignore", "e"),
          { nowMs, actor: "winner" },
        );
        await expect(queue("113")).resolves.toMatchObject({ status: "ignored", attempts: 3 });
        winnerRows = await decisionRows();
      });
      await expect(
        decideManualReview(losingDb, "staging", reviewId, decision(loserKind, "f"), {
          nowMs: nowMs + 60_000,
          actor: "loser",
        }),
      ).rejects.toThrow("manual_review_decision_race");
      expect(winnerRows).toBeDefined();
      expect(await decisionRows()).toEqual(winnerRows);
    },
  );
});

async function expectManualEventWinner(
  itemId: string,
  publishedAt: string,
  event: ReturnType<typeof manualEventRequest>["event"],
  nowMs: number,
) {
  const source = "naver-board-56";
  const url = `https://game.naver.com/lounge/nikke/board/detail/${itemId}`;
  // Independently reconstruct the specified metadata-only fixture, not stored rows.
  const normalizedText = `공지 ${itemId}\n${url}\n${publishedAt}\nmanual_review_metadata_only`;
  const contentHash = await fixtureSha256(normalizedText);
  // Spell out canonical key order independently of the production serializer.
  const eventHash = await fixtureSha256(
    JSON.stringify({
      endsAtKst: event.endsAtKst,
      eventType: "solo",
      itemId,
      scheduleStatus: "confirmed",
      source,
      startsAtKst: event.startsAtKst,
    }),
  );
  const eventId = `${source}:${itemId}:manual:${eventHash.slice(0, 20)}`;
  // The published game-day contract rolls over at 05:00 KST (UTC + 4 hours).
  const forecastDate = new Date(nowMs + 4 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const forecastId = `supply-${forecastDate}-v1`;
  const [candidates, evidence, watermarks] = await testEnv.FORECAST_DB.batch([
    testEnv.FORECAST_DB.prepare(
      `SELECT c.state, c.source_status, c.revision, c.forecast_id, c.schedule_event_id,
              e.event_type, e.source, e.source_item_id,
              e.starts_at, e.ends_at, e.schedule_status, e.manual_review
       FROM forecast_candidates c
       JOIN schedule_events e ON e.event_id = c.schedule_event_id
       ORDER BY c.candidate_id`,
    ),
    testEnv.FORECAST_DB.prepare(
      `SELECT cs.source, cs.source_item_id, s.content_hash,
              c.forecast_id, c.schedule_event_id
       FROM candidate_sources cs
       JOIN forecast_candidates c ON c.candidate_id = cs.candidate_id
       JOIN source_items s ON s.source = cs.source AND s.item_id = cs.source_item_id
       ORDER BY cs.candidate_id, cs.source, cs.source_item_id`,
    ),
    testEnv.FORECAST_DB.prepare(
      "SELECT source, item_id, published_at, content_hash, updated_at FROM source_watermarks ORDER BY source",
    ),
  ]);
  expect(candidates?.results).toEqual([
    {
      state: "x_unavailable",
      source_status: "x_unavailable",
      revision: 1,
      forecast_id: forecastId,
      schedule_event_id: eventId,
      event_type: "solo",
      source,
      source_item_id: itemId,
      starts_at: new Date(`${event.startsAtKst}:00+09:00`).toISOString(),
      ends_at: new Date(`${event.endsAtKst}:00+09:00`).toISOString(),
      schedule_status: "confirmed",
      manual_review: 0,
    },
  ]);
  expect(evidence?.results).toEqual([
    {
      source,
      source_item_id: itemId,
      content_hash: contentHash,
      forecast_id: forecastId,
      schedule_event_id: eventId,
    },
  ]);
  expect(watermarks?.results).toEqual([
    {
      source,
      item_id: itemId,
      published_at: publishedAt,
      content_hash: contentHash,
      updated_at: new Date(nowMs).toISOString(),
    },
  ]);
}

async function fixtureSha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function interleavedDatabase(beforeBatch: () => Promise<void>): D1Database {
  const db = testEnv.FORECAST_DB;
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      // All loser reads/preparation finish before the competing real D1 writes.
      await beforeBatch();
      return db.batch<T>(statements);
    },
  } as D1Database;
}

async function decisionRows() {
  const results = await testEnv.FORECAST_DB.batch([
    testEnv.FORECAST_DB.prepare("SELECT * FROM source_queue ORDER BY source, item_id"),
    testEnv.FORECAST_DB.prepare("SELECT * FROM source_manual_reviews ORDER BY review_id"),
    testEnv.FORECAST_DB.prepare("SELECT * FROM forecast_ops_alerts ORDER BY alert_key"),
    testEnv.FORECAST_DB.prepare("SELECT * FROM source_items ORDER BY source, item_id"),
    testEnv.FORECAST_DB.prepare("SELECT * FROM schedule_events ORDER BY event_id"),
    testEnv.FORECAST_DB.prepare("SELECT * FROM source_watermarks ORDER BY source"),
    testEnv.FORECAST_DB.prepare("SELECT * FROM forecast_candidates ORDER BY candidate_id"),
    testEnv.FORECAST_DB.prepare(
      "SELECT * FROM candidate_sources ORDER BY candidate_id, source, source_item_id",
    ),
  ]);
  return results.map((result) => result.results);
}

function manualEventRequest(suffix: string, nowMs: number, dayOffset = 1) {
  const kstMinute = (days: number) =>
    new Date(nowMs + days * 24 * 60 * 60 * 1_000 + 9 * 60 * 60 * 1_000).toISOString().slice(0, 16);
  return {
    ...decision("manual_event", suffix),
    event: {
      eventType: "solo",
      startsAtKst: kstMinute(dayOffset),
      endsAtKst: kstMinute(dayOffset + 7),
      scheduleStatus: "confirmed",
    },
  };
}

async function insertManualReview(
  itemId: string,
  source: NaverSourceKind = "naver-board-56",
  now = new Date().toISOString(),
) {
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
