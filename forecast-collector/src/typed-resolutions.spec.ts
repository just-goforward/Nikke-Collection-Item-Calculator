import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadGrants } from "./grants";
import { decideManualReview, readManualReview } from "./manual-review";
import { parseNoticeDetail } from "./notice";
import { runRuntimeIngestion } from "./runtime-ingestion";
import { runtimeTestDb } from "./test-runtime-db";
import { seedNormalUsageGuard } from "./test-usage-guard";
import type { CollectorEnv } from "./types";

let sqlite: DatabaseSync, env: CollectorEnv, reviewId: string;
beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../fixtures/schema-v27-test.sql", import.meta.url), "utf8"));
  const db = runtimeTestDb(sqlite);
  env = {
    FORECAST_DB: db,
    USAGE_GUARD_DB: db,
    ADMIN_TOKEN: "test",
    ENVIRONMENT: "staging",
    DEPLOY_SHA: "test",
    POLL_MODE: "both",
    RUNTIME_INGESTION_ENABLED: "true",
  };
  await seedNormalUsageGuard(db);
  const payload = JSON.parse(
    readFileSync(new URL("../fixtures/naver-detail-8091116.json", import.meta.url), "utf8"),
  );
  const item = await parseNoticeDetail(payload, 48, "8091116");
  if (!item) throw new Error("fixture_missing");
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
  await runRuntimeIngestion(env, { fetcher: async () => Response.json(payload) });
  const row = sqlite.prepare("SELECT review_id FROM source_manual_reviews").get();
  reviewId = String(row?.["review_id"]);
});
afterEach(() => sqlite.close());
async function request() {
  const review = await readManualReview(env.FORECAST_DB, reviewId);
  return {
    requestId: `mrq-${"a".repeat(32)}`,
    decision: "manual_event",
    reason: "confirmed grant date",
    runId: 1,
    event: null,
    resolution: {
      kind: "grant",
      grantGameDate: "2026-08-22",
      kits: [{ law: "box-ii-v1", count: 24 }],
      claimUntil: null,
      binding: review && "resolutionBinding" in review ? review.resolutionBinding : null,
    },
  };
}
it("settles a revision-bound typed grant once and preserves retry identity", async () => {
  const input = await request();
  expect(input.resolution.binding).toBeTruthy();
  const result = await decideManualReview(env.FORECAST_DB, "staging", reviewId, input, {
    runtimeIngestion: true,
  });
  expect(result.idempotent).toBe(false);
  expect((await loadGrants(env.FORECAST_DB))[0]?.id).toBe(
    "grant:naver-board-48:8091116:2026-08-22:1",
  );
  expect(
    (
      await decideManualReview(env.FORECAST_DB, "staging", reviewId, input, {
        runtimeIngestion: true,
      })
    ).idempotent,
  ).toBe(true);
});
it("rejects a stale content binding without grant writes", async () => {
  const input = await request();
  if (!input.resolution.binding) throw new Error("binding_missing");
  input.resolution.binding.contentHash = "0".repeat(64);
  await expect(decideManualReview(env.FORECAST_DB, "staging", reviewId, input)).rejects.toThrow(
    "manual_review_stale_evidence",
  );
  expect(await loadGrants(env.FORECAST_DB)).toEqual([]);
});
it("rejects a changed schedule context without grant writes", async () => {
  const input = await request();
  sqlite.exec("UPDATE schedule_events SET reason='new-context'");
  await expect(decideManualReview(env.FORECAST_DB, "staging", reviewId, input)).rejects.toThrow(
    "manual_review_stale_evidence",
  );
  expect(await loadGrants(env.FORECAST_DB)).toEqual([]);
});
