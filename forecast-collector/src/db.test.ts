import { createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import schemaSql from "../schema.sql?raw";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import {
  candidateExists,
  listProposalCandidates,
  markCandidateProposed,
  nextNaverRetryAt,
  persistCandidate,
  persistSourceItemsAndEvents,
} from "./db";
import type { CollectorEnv, NormalizedSourceItem, ScheduleEvent } from "./types";
import worker from "./worker";

const testEnv = env as unknown as CollectorEnv;
type WorkerFetch = NonNullable<typeof worker.fetch>;
type WorkerRequest = Parameters<WorkerFetch>[0];

beforeEach(async () => {
  await reset();
  for (const statement of schemaSql
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    await testEnv.FORECAST_DB.prepare(statement).run();
  }
});

describe("forecast collector D1 contract", () => {
  it("stores one idempotent candidate and advances only through allowed states", async () => {
    const item = sourceItem();
    const event = soloEvent(item);
    await persistSourceItemsAndEvents(
      testEnv.FORECAST_DB,
      [item],
      [event],
      new Date().toISOString(),
    );
    const watermark = await testEnv.FORECAST_DB.prepare(
      "SELECT item_id, published_at, content_hash FROM source_watermarks WHERE source = ?",
    )
      .bind(item.source)
      .first<{ item_id: string; published_at: string; content_hash: string }>();
    expect(watermark).toEqual({
      item_id: item.itemId,
      published_at: item.publishedAt,
      content_hash: item.contentHash,
    });
    const resolved = resolveSoloSchedule([event], Date.parse("2026-08-24T00:00:00Z"));
    if (!resolved) throw new Error("Expected a resolved schedule.");
    const candidate = await buildForecastCandidate(
      resolved,
      [],
      { status: "x_unavailable", sourceItem: null, reason: "test" },
      Date.parse("2026-08-24T00:00:00Z"),
      1,
    );
    await persistCandidate(testEnv.FORECAST_DB, candidate, event.eventId, "2026-08-24", 1);
    await persistCandidate(testEnv.FORECAST_DB, candidate, event.eventId, "2026-08-24", 1);

    expect(
      await candidateExists(testEnv.FORECAST_DB, event.eventId, "2026-08-24", "x_unavailable"),
    ).toBe(candidate.candidate.candidateId);
    expect(await listProposalCandidates(testEnv.FORECAST_DB)).toEqual([
      { payloadHash: candidate.payloadHash, candidate: candidate.candidate },
    ]);
    await expect(
      markCandidateProposed(testEnv.FORECAST_DB, candidate.candidate.candidateId),
    ).resolves.toBe(true);
    await expect(
      markCandidateProposed(testEnv.FORECAST_DB, candidate.candidate.candidateId),
    ).resolves.toBe(false);
  });

  it("keeps health public but protects candidate data with a timing-safe bearer check", async () => {
    const handler = worker.fetch;
    if (!handler) throw new Error("Missing Worker fetch handler.");
    const context = createExecutionContext();
    const health = await handler(
      new Request("https://collector.test/health") as WorkerRequest,
      testEnv,
      context,
    );
    const unauthorized = await handler(
      new Request("https://collector.test/admin/candidates") as WorkerRequest,
      testEnv,
      createExecutionContext(),
    );
    const authorized = await handler(
      new Request("https://collector.test/admin/candidates", {
        headers: { authorization: "Bearer test-forecast-admin-token" },
      }) as WorkerRequest,
      testEnv,
      createExecutionContext(),
    );

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", sources: {}, candidateCounts: {} });
    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
  });

  it("caps exponential Naver backoff at thirty minutes", () => {
    const now = Date.parse("2026-08-24T00:00:00Z");
    expect(nextNaverRetryAt(now, 3)).toBe("2026-08-24T00:06:00.000Z");
    expect(nextNaverRetryAt(now, 20)).toBe("2026-08-24T00:30:00.000Z");
  });
});

function sourceItem(): NormalizedSourceItem {
  return {
    source: "naver-board-56",
    itemId: "8060044",
    url: "https://game.naver.com/lounge/nikke/board/detail/8060044",
    title: "8월 솔로 레이드",
    excerpt: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
    normalizedText: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
    publishedAt: "2026-08-18T03:00:00.000Z",
    contentHash: "a".repeat(64),
    structured: true,
    official: true,
  };
}

function soloEvent(item: NormalizedSourceItem): ScheduleEvent {
  return {
    eventId: "naver-board-56:8060044:solo",
    eventType: "solo",
    sourceItem: item,
    startsAt: "2026-08-20T03:00:00.000Z",
    endsAt: "2026-08-26T19:59:00.000Z",
    scheduleStatus: "confirmed",
    manualReview: false,
    reason: null,
  };
}
