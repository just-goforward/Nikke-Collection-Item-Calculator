import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as supplyBuild from "../../shared/supplyForecastBuild";
import * as candidateBuild from "../../shared/supplyForecastCandidate";
import { sourceItemAndEventStatements } from "./db";
import { planGrants } from "./grants";
import { decideManualReview } from "./manual-review";
import { parseNoticeDetail } from "./notice";
import { runRuntimeCandidate, runRuntimeIngestion } from "./runtime-ingestion";
import { runtimeTestDb } from "./test-runtime-db";
import { seedNormalUsageGuard } from "./test-usage-guard";
import type { CollectorEnv, ScheduleEvent } from "./types";

it.each([7833931, 7837735, 7860406, 7877359, 8091116])(
  "measures populated-DB ingestion worker CPU for %s",
  async (id) => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(
        readFileSync(new URL("../fixtures/schema-v27-test.sql", import.meta.url), "utf8"),
      );
      const db = runtimeTestDb(sqlite);
      const env: CollectorEnv = {
        FORECAST_DB: db,
        USAGE_GUARD_DB: db,
        ADMIN_TOKEN: "local",
        ENVIRONMENT: "staging",
        DEPLOY_SHA: "local",
        POLL_MODE: "both",
        RUNTIME_INGESTION_ENABLED: "true",
        RUNTIME_NOTICE_DAILY_LIMIT: "2",
      };
      await seedNormalUsageGuard(db);
      const payload = JSON.parse(
        readFileSync(new URL(`../fixtures/naver-detail-${id}.json`, import.meta.url), "utf8"),
      );
      const item = await parseNoticeDetail(payload, payload.content.board.boardId, String(id));
      if (!item) throw new Error("fixture_missing");
      const opening = {
        ...item,
        itemId: "7800000",
        title: "솔로 레이드 - 애니힐리오",
        normalizedText: "솔로 레이드 - 애니힐리오",
        source: "naver-board-56" as const,
      };
      const event: ScheduleEvent = {
        eventId: "r38",
        eventType: "solo",
        sourceItem: opening,
        startsAt: "2026-06-18T03:00:00.000Z",
        endsAt: "2026-06-24T19:59:00.000Z",
        scheduleStatus: "confirmed",
        manualReview: false,
        reason: null,
      };
      const events = [event];
      if (id !== 7833931)
        events.push({
          ...event,
          eventId: "r38-suspend",
          endsAt: "2026-06-22T19:59:59.000Z",
          segment: {
            round: 38,
            segment: 1,
            kind: "suspend",
            effectiveFrom: event.startsAt as string,
            effectiveUntil: "2026-06-22T19:59:59.000Z",
          },
        });
      await db.batch(sourceItemAndEventStatements(db, [opening], events, new Date().toISOString()));
      const insert = sqlite.prepare(`INSERT INTO schedule_events
      (event_id,event_type,source,source_item_id,starts_at,ends_at,schedule_status,manual_review,reason,observed_at)
      VALUES(?,'cooperation','naver-board-56','7800000',?,?,'confirmed',0,NULL,?)`);
      for (let index = 0; index < 240; index++) {
        const start = new Date(Date.UTC(2000, 0, 1 + index * 28)).toISOString();
        insert.run(
          `history-${index}`,
          start,
          new Date(Date.parse(start) + 7 * 86400000).toISOString(),
          start,
        );
      }
      const revision = sqlite.prepare(`INSERT INTO source_notice_revisions
      (source,item_id,source_revision,body_hash,revision_hash,semantic_hash,item_json,events_json,observed_at)
      VALUES('naver-board-48',?,1,?,?,?,?,'[]',?)`);
      for (let index = 0; index < 60; index++)
        revision.run(
          `history-${index}`,
          "a".repeat(64),
          "b".repeat(64),
          "c".repeat(64),
          JSON.stringify({ ...item, normalizedText: "점검 ".repeat(5500) }),
          item.publishedAt,
        );
      if (id === 7837735) {
        const original = JSON.parse(
          readFileSync(new URL("../fixtures/naver-detail-7833931.json", import.meta.url), "utf8"),
        );
        const origin = await parseNoticeDetail(original, 11, "7833931");
        if (!origin) throw new Error("fixture_missing");
        const plan = await planGrants(db, origin, 0);
        await db.batch(plan.statements);
      }
      sqlite
        .prepare(`INSERT INTO source_queue
      (source,item_id,url,title,published_at,official,status,attempts,first_seen_at,updated_at)
      VALUES(?,?,?,?,?,1,'pending',0,?,?)`)
        .run(
          item.source,
          item.itemId,
          item.url,
          item.title,
          item.publishedAt,
          item.publishedAt,
          item.publishedAt,
        );
      let snapshotCpuMs = 0,
        publicationCpuMs = 0;
      const originalSnapshot = supplyBuild.buildScheduleForecastSnapshot;
      const originalCandidate = candidateBuild.buildSupplyForecastCandidate;
      vi.spyOn(supplyBuild, "buildScheduleForecastSnapshot").mockImplementation((...args) => {
        const start = process.threadCpuUsage();
        try {
          return originalSnapshot(...args);
        } finally {
          const cpu = process.threadCpuUsage(start);
          snapshotCpuMs += (cpu.user + cpu.system) / 1000;
        }
      });
      vi.spyOn(candidateBuild, "buildSupplyForecastCandidate").mockImplementation((...args) => {
        const start = process.threadCpuUsage();
        try {
          return originalCandidate(...args);
        } finally {
          const cpu = process.threadCpuUsage(start);
          publicationCpuMs += (cpu.user + cpu.system) / 1000;
        }
      });
      const started = process.threadCpuUsage();
      const result = await runRuntimeIngestion(env, {
        fetcher: async () => Response.json(payload),
        candidateNowMs: Date.parse("2026-06-28T03:00:00Z"),
      });
      const used = process.threadCpuUsage(started),
        cpuMs = (used.user + used.system) / 1000;
      const ingestionSnapshotCpuMs = snapshotCpuMs;
      const ingestionPublicationCpuMs = publicationCpuMs;
      if (id === 8091116) await resolveAmbiguousCpuFixture(db, sqlite);
      snapshotCpuMs = 0;
      publicationCpuMs = 0;
      vi.mocked(supplyBuild.buildScheduleForecastSnapshot).mockClear();
      vi.mocked(candidateBuild.buildSupplyForecastCandidate).mockClear();
      const candidateStart = process.threadCpuUsage();
      const publication = await runRuntimeCandidate(env, Date.parse("2026-06-28T03:00:00Z"));
      const candidateCpu = process.threadCpuUsage(candidateStart);
      const candidateCpuMs = (candidateCpu.user + candidateCpu.system) / 1000;
      expect(supplyBuild.buildScheduleForecastSnapshot).toHaveBeenCalledOnce();
      expect(candidateBuild.buildSupplyForecastCandidate).toHaveBeenCalledOnce();
      console.log(
        JSON.stringify({
          fixture: id,
          cpuMs,
          candidateCpuMs,
          snapshotCpuMs,
          publicationCpuMs,
          ingestionSnapshotCpuMs,
          ingestionPublicationCpuMs,
          node: process.version,
          method:
            "worker-thread user+system CPU; 240 history events + 60 16k-character revisions; SQLite; mocked GET",
          result,
        }),
      );
      expect(result.outcome).toBe("completed");
      expect(publication).toMatchObject({ outcome: "completed", candidateCreated: true });
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM forecast_candidates").get()?.["count"],
      ).toBe(1);
      expect(cpuMs).toBeLessThanOrEqual(50);
      expect(candidateCpuMs).toBeLessThanOrEqual(50);
    } finally {
      vi.restoreAllMocks();
      sqlite.close();
    }
  },
);

async function resolveAmbiguousCpuFixture(db: D1Database, sqlite: DatabaseSync) {
  // Publication CPU fixture only: model a completed operator resolution and
  // retirement of its obsolete tentative event. This is not an end-to-end
  // assertion that an ambiguous, unresolved notice can publish.
  const review = sqlite
    .prepare("SELECT review_id FROM source_manual_reviews WHERE item_id='8091116'")
    .get();
  await decideManualReview(
    db,
    "staging",
    String(review?.["review_id"]),
    {
      requestId: `mrq-${"a".repeat(32)}`,
      decision: "ignore",
      reason: "CPU fixture: operator excludes ambiguous compensation notice",
      runId: 1,
      event: null,
    },
    { runtimeIngestion: true },
  );
  sqlite.exec(`UPDATE schedule_events SET reason='runtime_notice_replaced'
    WHERE source_item_id='8091116' AND manual_review=1`);
}
