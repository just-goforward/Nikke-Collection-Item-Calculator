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
  readCanaryReport,
} from "./db";
import { finishInvocation, startInvocation } from "./source-queue";
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
    expect(await health.json()).toEqual({
      status: "ok",
      collector: { status: "missing", lastFinishedAt: null },
      candidateCounts: {},
    });
    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
  });

  it("caps exponential Naver backoff at thirty minutes", () => {
    const now = Date.parse("2026-08-24T00:00:00Z");
    expect(nextNaverRetryAt(now, 3)).toBe("2026-08-24T00:06:00.000Z");
    expect(nextNaverRetryAt(now, 20)).toBe("2026-08-24T00:30:00.000Z");
  });

  it("builds the canary window only from the requested deployment SHA", async () => {
    const now = Date.parse("2026-08-24T00:00:00Z");
    const firstStartedAt = new Date(now - 13 * 60 * 60 * 1000).toISOString();
    const recentStartedAt = new Date(now - 60 * 60 * 1000).toISOString();
    await completedInvocation("old-deployment", Date.parse(recentStartedAt));
    await completedInvocation("current-deployment", Date.parse(firstStartedAt));
    await completedInvocation("current-deployment", Date.parse(recentStartedAt));

    const report = await readCanaryReport(testEnv.FORECAST_DB, now, "current-deployment");

    expect(report.deploymentSha).toBe("current-deployment");
    expect(report.window.eligible).toBe(true);
    expect(report).toMatchObject({
      version: 3,
      acceptance: { windowHours: 12, minimumScheduled: 200, minimumCompletionRate: 0.99 },
      invocations: { scheduled: 1, completed: 1, successRate: 1, abandoned: 0 },
    });
  });

  it("counts a hard-terminated running invocation as abandoned", async () => {
    const now = Date.parse("2026-08-24T00:00:00Z");
    await completedInvocation("current-deployment", now - 13 * 60 * 60 * 1000);
    await startInvocation(
      testEnv.FORECAST_DB,
      "current-deployment",
      now - 2 * 60 * 60 * 1000,
      "both",
    );
    await completedInvocation("current-deployment", now - 60 * 60 * 1000);

    const report = await readCanaryReport(testEnv.FORECAST_DB, now, "current-deployment");

    expect(report.invocations).toMatchObject({ scheduled: 2, completed: 1, abandoned: 1 });
    expect(report.window.earlyFailure).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("requires two hundred completed invocations across an eligible twelve-hour window", async () => {
    const now = Date.parse("2026-08-24T00:00:00Z");
    await completedInvocation("boundary-deployment", now - 13 * 60 * 60 * 1000);
    await testEnv.FORECAST_DB.prepare(
      `WITH RECURSIVE seq(i) AS (
         SELECT 0
         UNION ALL
         SELECT i + 1 FROM seq WHERE i < 199
       )
       INSERT INTO collector_invocations (
         invocation_id, deployment_sha, scheduled_at, started_at, finished_at,
         status, poll_mode, queued_count
       )
       SELECT
         'boundary-deployment:' || i,
         'boundary-deployment',
         strftime('%Y-%m-%dT%H:%M:%fZ', ? + i * 180, 'unixepoch'),
         strftime('%Y-%m-%dT%H:%M:%fZ', ? + i * 180, 'unixepoch'),
         strftime('%Y-%m-%dT%H:%M:%fZ', ? + i * 180 + 1, 'unixepoch'),
         'completed',
         'both',
         0
       FROM seq`,
    )
      .bind(
        Math.floor((now - 10 * 60 * 60 * 1000) / 1000),
        Math.floor((now - 10 * 60 * 60 * 1000) / 1000),
        Math.floor((now - 10 * 60 * 60 * 1000) / 1000),
      )
      .run();

    const passing = await readCanaryReport(testEnv.FORECAST_DB, now, "boundary-deployment");
    expect(passing.invocations).toMatchObject({ scheduled: 200, completed: 200 });
    expect(passing.passed).toBe(true);

    await testEnv.FORECAST_DB.prepare(
      "DELETE FROM collector_invocations WHERE invocation_id = 'boundary-deployment:199'",
    ).run();
    const failing = await readCanaryReport(testEnv.FORECAST_DB, now, "boundary-deployment");
    expect(failing.invocations.scheduled).toBe(199);
    expect(failing.passed).toBe(false);
  });

  it("includes all 102 hard terminations in a 240-invocation canary denominator", async () => {
    const now = Date.parse("2026-08-24T00:00:00Z");
    await completedInvocation("loaded-deployment", now - 13 * 60 * 60 * 1000);
    await testEnv.FORECAST_DB.prepare(
      `WITH RECURSIVE seq(i) AS (
         SELECT 0
         UNION ALL
         SELECT i + 1 FROM seq WHERE i < 239
       )
       INSERT INTO collector_invocations (
         invocation_id, deployment_sha, scheduled_at, started_at, finished_at,
         status, poll_mode, queued_count
       )
       SELECT
         'loaded-deployment:' || i,
         'loaded-deployment',
         strftime('%Y-%m-%dT%H:%M:%fZ', ? + i * 180, 'unixepoch'),
         strftime('%Y-%m-%dT%H:%M:%fZ', ? + i * 180, 'unixepoch'),
         CASE WHEN i < 102 THEN NULL
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ? + i * 180 + 1, 'unixepoch') END,
         CASE WHEN i < 102 THEN 'running' ELSE 'completed' END,
         'both',
         0
       FROM seq`,
    )
      .bind(
        Math.floor((now - 12 * 60 * 60 * 1000) / 1000),
        Math.floor((now - 12 * 60 * 60 * 1000) / 1000),
        Math.floor((now - 12 * 60 * 60 * 1000) / 1000),
      )
      .run();

    const report = await readCanaryReport(testEnv.FORECAST_DB, now, "loaded-deployment");

    expect(report.invocations).toMatchObject({
      scheduled: 240,
      completed: 138,
      abandoned: 102,
      successRate: 0.575,
      latestStatus: "completed",
    });
    expect(report.window).toMatchObject({ eligible: true, earlyFailure: true });
    expect(report.passed).toBe(false);
  });
});

async function completedInvocation(deploymentSha: string, scheduledTime: number) {
  const id = await startInvocation(testEnv.FORECAST_DB, deploymentSha, scheduledTime, "both");
  await finishInvocation(testEnv.FORECAST_DB, id, "completed", 0, null, null);
}

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
