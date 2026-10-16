import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { executeTestSql } from "../../shared/testD1Sql";
import fixture from "../fixtures/official-solo-history/8060044.json";
import versionsMigration from "../migrations/0022_forecast_runtime_versions.sql?raw";
import publicationMigration from "../migrations/0023_forecast_runtime_publication.sql?raw";
import migration from "../migrations/0024_runtime_ingestion.sql?raw";
import schema from "../schema.sql?raw";
import { parseNoticeDetail } from "./notice";
import { runRuntimeIngestion } from "./runtime-ingestion";
import { seedNormalUsageGuard } from "./test-usage-guard";
import type { CollectorEnv } from "./types";
import worker from "./worker";

const testEnv: CollectorEnv = {
  FORECAST_DB: env.FORECAST_DB,
  USAGE_GUARD_DB: env.USAGE_GUARD_DB,
  ADMIN_TOKEN: env.ADMIN_TOKEN,
  DEPLOY_SHA: env.DEPLOY_SHA,
  POLL_MODE: "both",
  ENVIRONMENT: "staging",
  RUNTIME_INGESTION_ENABLED: "true",
  COLLECT_ENABLED: "true",
};

beforeEach(async () => {
  await reset();
  await executeTestSql(testEnv.FORECAST_DB, schema, applyD1Migrations);
  await executeTestSql(testEnv.FORECAST_DB, versionsMigration, applyD1Migrations);
  await executeTestSql(testEnv.FORECAST_DB, publicationMigration, applyD1Migrations);
  await executeTestSql(testEnv.FORECAST_DB, migration, applyD1Migrations);
  await seedNormalUsageGuard(testEnv.USAGE_GUARD_DB);
});

it("uses the started-at index without scanning or sorting the latest three ingestion runs", async () => {
  const plan = await testEnv.FORECAST_DB.prepare(
    `EXPLAIN QUERY PLAN
     SELECT status FROM runtime_ingestion_runs
     WHERE started_at>=? ORDER BY started_at DESC LIMIT 3`,
  )
    .bind("2026-08-20T00:00:00.000Z")
    .all<{ detail: string }>();
  const details = plan.results.map((row) => row.detail).join("\n");
  expect(details).toContain(
    "SEARCH runtime_ingestion_runs USING INDEX runtime_ingestion_runs_started_at",
  );
  expect(details).not.toMatch(/SCAN|TEMP B-TREE/);
});

it("runs the scheduled metadata → full body → D1 v3 candidate path in workerd", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/8060044")) return Response.json(fixture);
    const board = Number(url.searchParams.get("boardId"));
    return Response.json({
      code: 200,
      content: {
        feeds: [
          {
            feed: {
              ...fixture.content.feed,
              feedId: board === 56 ? 8060044 : 123,
              title: board === 56 ? fixture.content.feed.title : "공지",
              contents: undefined,
            },
            user: board === 56 ? fixture.content.user : { userRoleCode: "member" },
            board: { boardId: board },
          },
        ],
      },
    });
  });
  try {
    const context = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "*/3 * * * *", noRetry: vi.fn() },
      testEnv,
      context,
    );
    await waitOnExecutionContext(context);
    const row = await testEnv.FORECAST_DB.prepare(
      "SELECT payload_json FROM forecast_candidates",
    ).first<{ payload_json: string }>();
    expect(JSON.parse(row?.payload_json ?? "{}")).toMatchObject({
      rulesVersion: "schedule-kit-v3",
      certifiedSnapshot: { version: "certified-daily-v3" },
    });
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/8060044"))).toBe(true);
  } finally {
    fetcher.mockRestore();
  }
});

it("rolls back D1 batch writes when the lease expires during full-body retrieval", async () => {
  const item = await parseNoticeDetail(fixture, 56, "8060044");
  if (!item) throw new Error("fixture_missing");
  await testEnv.FORECAST_DB.prepare(`INSERT INTO source_queue
    (source,item_id,url,title,published_at,official,status,attempts,first_seen_at,updated_at)
    VALUES(?,?,?,?,?,1,'pending',0,?,?)`)
    .bind(
      item.source,
      item.itemId,
      item.url,
      item.title,
      item.publishedAt,
      item.publishedAt,
      item.publishedAt,
    )
    .run();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    await testEnv.FORECAST_DB.prepare(
      "UPDATE runtime_ingestion_runs SET lease_until='2000-01-01T00:00:00.000Z'",
    ).run();
    return Response.json(fixture);
  });
  await expect(
    runRuntimeIngestion(testEnv, { fetcher, candidateNowMs: Date.parse("2026-08-20T12:00:00Z") }),
  ).rejects.toThrow("runtime_ingestion_lease_expired");
  expect(await testEnv.FORECAST_DB.prepare("SELECT * FROM forecast_candidates").first()).toBeNull();
  expect(await testEnv.FORECAST_DB.prepare("SELECT * FROM source_items").first()).toBeNull();
});

it("fences legacy Actions source writes only while staging runtime ownership is enabled", async () => {
  const request = new Request("https://collector.example/admin/source-queue/process", {
    method: "POST",
    headers: {
      authorization: `Bearer ${testEnv.ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ mode: "bootstrap", results: [] }),
  });
  if (!isLocalIncomingRequest(request)) throw new Error("fixture_unexpected_cf_metadata");
  const response = await worker.fetch(
    request,
    {
      ...testEnv,
      ADMIN_RATE_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: true }),
      },
    },
    createExecutionContext(),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "runtime_ingestion_owns_source_queue" });
});

function isLocalIncomingRequest(
  request: Request,
): request is Request<unknown, IncomingRequestCfProperties> {
  // Locally constructed requests omit edge metadata. Check that contract rather
  // than asserting compatibility between DOM and workerd Request constructors.
  return request.cf === undefined;
}
