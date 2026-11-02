import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTestSql } from "../../shared/testD1Sql";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import { sha256Hex } from "./crypto";
import {
  candidateExists,
  candidateStatements,
  listProposalCandidates,
  nextNaverRetryAt,
  persistCandidate,
  persistSourceItemsAndEvents,
  readCanaryReport,
  readHealth,
  sourceItemAndEventStatements,
} from "./db";
import {
  completeInvocation as finishInvocation,
  seedInvocation as startInvocation,
} from "./test-invocation-history";
import schemaSql from "./test-schema";
import { seedNormalUsageGuard } from "./test-usage-guard";
import type { CollectorEnv, NormalizedSourceItem, ScheduleEvent } from "./types";
import worker from "./worker";

const testEnv = env as unknown as CollectorEnv;
type WorkerFetch = NonNullable<typeof worker.fetch>;

it("keeps the real profiling SHA in health but excludes profiling from canary evidence", async () => {
  const now = Date.now();
  const id = await startInvocation(
    testEnv.FORECAST_DB,
    "real-sha",
    now,
    "both",
    "profile-board-48:",
  );
  expect(id).toBe(`profile-board-48:real-sha:${now}`);
  expect((await readHealth(testEnv.FORECAST_DB)).collector.deploymentSha).toBe("real-sha");
  expect((await readCanaryReport(testEnv.FORECAST_DB, now, "real-sha")).invocations.scheduled).toBe(
    0,
  );
});
type WorkerRequest = Parameters<WorkerFetch>[0];

const deniedFetch = vi.fn(async () => {
  throw new Error("Unexpected outbound fetch in collector D1 tests.");
});

beforeEach(async () => {
  deniedFetch.mockClear();
  vi.stubGlobal("fetch", deniedFetch);
  await reset();
  await executeTestSql(testEnv.FORECAST_DB, schemaSql, applyD1Migrations);
  await seedNormalUsageGuard(testEnv.USAGE_GUARD_DB);
});

afterEach(() => {
  try {
    expect(deniedFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("forecast collector D1 contract", () => {
  // V5 needs its publication tuple in 0034; historical v4 retains its 0027 boundary.
  it.each([
    { version: "certified-daily-v4", schemaVersion: 27 },
    { version: "certified-daily-v5", schemaVersion: 34 },
  ] as const)(
    "does not persist $version before schema $schemaVersion and persists at that version",
    async ({ version, schemaVersion }) => {
      const db = testEnv.FORECAST_DB;
      const item = sourceItem();
      const event = soloEvent(item);
      const now = Date.parse("2026-08-24T00:00:00.000Z");
      await persistSourceItemsAndEvents(db, [item], [event], new Date(now).toISOString());
      const resolved = resolveSoloSchedule([event], now);
      if (!resolved) throw new Error("Expected a resolved schedule");
      const candidate = await buildForecastCandidate(
        resolved,
        [],
        {
          status: "x_unavailable",
          sourceItem: null,
          reason: "test",
        },
        now,
        1,
        [],
        { version },
      );
      expect(candidate.candidate.certifiedSnapshot?.version).toBe(version);
      await db
        .prepare("DELETE FROM schema_migrations WHERE version >= ?")
        .bind(schemaVersion)
        .run();
      const writes = await db.batch(
        candidateStatements(db, candidate, event.eventId, "2026-08-24", 1),
      );
      expect(writes.every((result) => result.meta.changes === 0)).toBe(true);
      expect((await db.prepare("SELECT * FROM forecast_candidates").all()).results).toEqual([]);
      expect((await db.prepare("SELECT * FROM candidate_sources").all()).results).toEqual([]);
      await db
        .prepare("INSERT INTO schema_migrations VALUES(?,CURRENT_TIMESTAMP)")
        .bind(schemaVersion)
        .run();
      await persistCandidate(db, candidate, event.eventId, "2026-08-24", 1);
      expect(
        await db.prepare("SELECT state,payload_hash FROM forecast_candidates").first(),
      ).toEqual({ state: candidate.candidate.sourceStatus, payload_hash: candidate.payloadHash });
      expect(await db.prepare("SELECT COUNT(*) n FROM candidate_sources").first()).toEqual({
        n: 1,
      });
    },
  );
  it("preserves changes() across D1 batch statements and clears it after a zero-row write", async () => {
    const db = testEnv.FORECAST_DB;
    const item = sourceItem();
    await persistSourceItemsAndEvents(db, [item], [], "2026-08-24T00:00:00.000Z");
    const results = await db.batch([
      db
        .prepare("UPDATE source_items SET title = 'claimed' WHERE source = ? AND item_id = ?")
        .bind(item.source, item.itemId),
      db
        .prepare(
          "UPDATE source_items SET excerpt = 'winner' WHERE source = ? AND item_id = ? AND changes() = 1",
        )
        .bind(item.source, item.itemId),
      db.prepare("SELECT changes() AS affected"),
      db.prepare("UPDATE source_items SET title = 'absent' WHERE item_id = 'missing'"),
      db
        .prepare(
          "UPDATE source_items SET excerpt = 'loser' WHERE source = ? AND item_id = ? AND changes() = 1",
        )
        .bind(item.source, item.itemId),
      db.prepare("SELECT changes() AS affected"),
    ]);
    expect(results[0]?.meta.changes).toBe(1);
    expect(results[1]?.meta.changes).toBe(1);
    expect(results[2]?.results).toEqual([{ affected: 1 }]);
    expect(results[3]?.meta.changes).toBe(0);
    expect(results[4]?.meta.changes).toBe(0);
    expect(results[5]?.results).toEqual([{ affected: 0 }]);
    expect(
      await db
        .prepare("SELECT title, excerpt FROM source_items WHERE source = ? AND item_id = ?")
        .bind(item.source, item.itemId)
        .first(),
    ).toEqual({ title: "claimed", excerpt: "winner" });
  });

  it("does not insert or update existing source and candidate rows when the write condition is false", async () => {
    const db = testEnv.FORECAST_DB;
    const item = sourceItem();
    const event = soloEvent(item);
    const nowMs = Date.parse("2026-08-24T00:00:00.000Z");
    const now = new Date(nowMs).toISOString();
    await persistSourceItemsAndEvents(db, [item], [event], now);
    const resolved = resolveSoloSchedule([event], nowMs);
    if (!resolved) throw new Error("Expected a resolved schedule.");
    const candidate = await buildForecastCandidate(
      resolved,
      [],
      { status: "x_unavailable", sourceItem: null, reason: "test" },
      nowMs,
      1,
    );
    await persistCandidate(db, candidate, event.eventId, "2026-08-24", 1);
    await db
      .prepare("DELETE FROM candidate_sources WHERE candidate_id = ?")
      .bind(candidate.candidate.candidateId)
      .run();
    const selects = [
      "SELECT * FROM source_items ORDER BY source, item_id",
      "SELECT * FROM schedule_events ORDER BY event_id",
      "SELECT * FROM source_watermarks ORDER BY source",
      "SELECT * FROM forecast_candidates ORDER BY candidate_id",
      "SELECT * FROM candidate_sources ORDER BY candidate_id, source, source_item_id",
    ];
    const condition = { sql: "0", bindings: [] };
    for (const state of ["observed", "parsed"]) {
      await db
        .prepare("UPDATE forecast_candidates SET state = ? WHERE candidate_id = ?")
        .bind(state, candidate.candidate.candidateId)
        .run();
      const before = (await db.batch(selects.map((sql) => db.prepare(sql)))).map(
        (result) => result.results,
      );
      const results = await db.batch([
        ...sourceItemAndEventStatements(
          db,
          [{ ...item, title: "loser", publishedAt: "2026-08-25T00:00:00.000Z" }],
          [{ ...event, endsAt: "2026-08-27T19:59:00.000Z" }],
          "2026-08-25T00:00:00.000Z",
          condition,
        ),
        ...candidateStatements(
          db,
          candidate,
          event.eventId,
          "2026-08-24",
          1,
          "2026-08-25T00:00:00.000Z",
          condition,
        ),
      ]);
      expect(results.every((result) => result.meta.changes === 0)).toBe(true);
      const after = (await db.batch(selects.map((sql) => db.prepare(sql)))).map(
        (result) => result.results,
      );
      expect(after).toEqual(before);
    }
  });

  it("enforces the restored source evidence immutability trigger", async () => {
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO source_notice_revisions (
         source, item_id, source_revision, body_hash, revision_hash, semantic_hash,
         item_json, events_json, observed_at
       ) VALUES ('naver-board-56', 'trigger-test', 1, ?, ?, ?, '{}', '[]', ?)`,
    )
      .bind("a".repeat(64), "b".repeat(64), "c".repeat(64), new Date().toISOString())
      .run();

    await expect(
      testEnv.FORECAST_DB.prepare(
        "DELETE FROM source_notice_revisions WHERE item_id = 'trigger-test'",
      ).run(),
    ).rejects.toThrow("source_evidence_immutable");
    expect(
      await testEnv.FORECAST_DB.prepare(
        "SELECT source_revision FROM source_notice_revisions WHERE item_id = 'trigger-test'",
      ).first(),
    ).toEqual({ source_revision: 1 });
  });

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
    const replay = await buildForecastCandidate(
      resolved,
      [],
      { status: "x_unavailable", sourceItem: null, reason: "test" },
      Date.parse("2026-08-24T00:00:01Z"),
      2,
    );
    expect(replay.candidate.candidateId).toBe(candidate.candidate.candidateId);
    await persistCandidate(testEnv.FORECAST_DB, replay, event.eventId, "2026-08-24", 2);

    expect(
      await candidateExists(testEnv.FORECAST_DB, event.eventId, "2026-08-24", "x_unavailable"),
    ).toBe(candidate.candidate.candidateId);
    expect(await listProposalCandidates(testEnv.FORECAST_DB)).toEqual([
      { payloadHash: candidate.payloadHash, candidate: candidate.candidate },
    ]);
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
      collector: { status: "missing", lastFinishedAt: null, deploymentSha: null },
      candidateCounts: {},
      operations: {
        dispatcher: {
          status: "missing",
          lastObservedAt: null,
          deploymentSha: null,
          errorCode: null,
        },
        actionableWork: { pending: 0, candidates: 0, oldestPendingAt: null },
        latestDispatch: null,
        alerts: { open: 0, unsent: 0, unsentCritical: 0 },
      },
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
      version: 4,
      acceptance: { windowHours: 12, minimumScheduled: 200, minimumCompletionRate: 0.99 },
      invocations: { scheduled: 1, completed: 1, successRate: 1, abandoned: 0 },
      dispatcher: { scheduled: 1, completed: 1, successRate: 1, abandoned: 0 },
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
    await insertDispatcherSeries("boundary-deployment", now - 10 * 60 * 60 * 1000, 200, 200);

    const passing = await readCanaryReport(testEnv.FORECAST_DB, now, "boundary-deployment");
    expect(passing.invocations).toMatchObject({ scheduled: 200, completed: 200 });
    expect(passing.passed).toBe(true);

    await testEnv.FORECAST_DB.prepare(
      "DELETE FROM collector_invocations WHERE invocation_id = 'boundary-deployment:199'",
    ).run();
    const failing = await readCanaryReport(testEnv.FORECAST_DB, now, "boundary-deployment");
    expect(failing.invocations.scheduled).toBe(199);
    expect(failing.passed).toBe(false);
    await testEnv.FORECAST_DB.prepare(`UPDATE collector_invocations
      SET invocation_id='runtime-candidate:' || invocation_id
      WHERE deployment_sha='boundary-deployment'
        AND CAST(substr(invocation_id,length('boundary-deployment:')+1) AS INTEGER)%2=1`).run();
    const alternating = await readCanaryReport(testEnv.FORECAST_DB, now, "boundary-deployment");
    expect(alternating.invocations).toMatchObject({ scheduled: 100, completed: 100 });
    expect(alternating.passed).toBe(true);
    // Seeds ~200 invocation rows; exceeded the 5 s default under full-suite load.
  }, 20_000);

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
  if (id === null) throw new Error("Expected a new test invocation");
  await finishInvocation(testEnv.FORECAST_DB, id, "completed", 0, null, null);
  await testEnv.FORECAST_DB.prepare(
    `INSERT OR IGNORE INTO dispatcher_invocations (
       invocation_id, deployment_sha, environment, scheduled_at, started_at, finished_at,
       status, actionable_count
     ) VALUES (?, ?, 'staging', ?, ?, ?, 'completed', 0)`,
  )
    .bind(
      `dispatcher:${deploymentSha}:${scheduledTime}`,
      deploymentSha,
      new Date(scheduledTime).toISOString(),
      new Date(scheduledTime).toISOString(),
      new Date(scheduledTime + 1_000).toISOString(),
    )
    .run();
  await insertSuccessfulSmoke(deploymentSha, scheduledTime);
}

async function insertDispatcherSeries(
  deploymentSha: string,
  startMs: number,
  count: number,
  completed: number,
) {
  for (let index = 0; index < count; index += 1) {
    const scheduled = startMs + index * 3 * 60 * 1_000;
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO dispatcher_invocations (
         invocation_id, deployment_sha, environment, scheduled_at, started_at, finished_at,
         status, actionable_count
       ) VALUES (?, ?, 'staging', ?, ?, ?, ?, 0)`,
    )
      .bind(
        `dispatcher-series:${deploymentSha}:${index}`,
        deploymentSha,
        new Date(scheduled).toISOString(),
        new Date(scheduled).toISOString(),
        index < completed ? new Date(scheduled + 1_000).toISOString() : null,
        index < completed ? "completed" : "running",
      )
      .run();
  }
}

async function insertSuccessfulSmoke(deploymentSha: string, nowMs: number) {
  const digest = await sha256Hex(`smoke:${deploymentSha}`);
  const dispatchId = `fd-${digest.slice(0, 32)}`;
  const runId = Number.parseInt(digest.slice(0, 8), 16) + 1;
  const now = new Date(nowMs).toISOString();
  await testEnv.FORECAST_DB.prepare(
    `INSERT OR IGNORE INTO workflow_dispatches (
       dispatch_id, slot_key, environment, dispatch_mode, work_fingerprint,
       pending_count, candidate_count, attempt, state, dispatcher_deployment_sha,
       created_at, requested_at, accepted_at, started_at, finished_at,
       github_http_status, github_run_id, github_run_attempt, github_run_url,
       discord_message_id, discord_sent_at
     ) VALUES (?, ?, 'staging', 'smoke', ?, 0, 0, 1, 'succeeded', ?, ?, ?, ?, ?, ?,
               204, ?, 1, ?, '123456789012345678', ?)`,
  )
    .bind(
      dispatchId,
      `smoke:${deploymentSha}`,
      digest,
      deploymentSha,
      now,
      now,
      now,
      now,
      now,
      runId,
      `https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/${runId}`,
      now,
    )
    .run();
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
