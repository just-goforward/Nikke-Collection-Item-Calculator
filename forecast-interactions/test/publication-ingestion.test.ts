import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import noticeFixture from "../../forecast-collector/fixtures/official-solo-history/8060044.json";
import versionsMigration from "../../forecast-collector/migrations/0022_forecast_runtime_versions.sql?raw";
import publicationMigration from "../../forecast-collector/migrations/0023_forecast_runtime_publication.sql?raw";
import ingestionMigration from "../../forecast-collector/migrations/0024_runtime_ingestion.sql?raw";
import pageMigration from "../../forecast-collector/migrations/0025_naver_page_policy.sql?raw";
import evidenceMigration from "../../forecast-collector/migrations/0026_source_judgment_evidence.sql?raw";
import grantsMigration from "../../forecast-collector/migrations/0027_board11_grants.sql?raw";
import collectorSchema from "../../forecast-collector/schema.sql?raw";
import { parseNoticeDetail } from "../../forecast-collector/src/notice.ts";
import { runRuntimeIngestion } from "../../forecast-collector/src/runtime-ingestion.ts";
import { seedNormalUsageGuard } from "../../forecast-collector/src/test-usage-guard.ts";
import type { CollectorEnv } from "../../forecast-collector/src/types.ts";
import { runDispatcher } from "../../forecast-dispatcher/src/dispatcher.ts";
import type { DispatcherEnv } from "../../forecast-dispatcher/src/types.ts";
import { encodeBase64 } from "../../shared/forecastPublication.ts";
import { executeTestSql } from "../../shared/testD1Sql.ts";
import type { InteractionRouterEnv } from "../src/types.ts";
import router from "../src/worker.ts";

// Cross-worker integration lives outside each Worker's production source boundary.
// Its dedicated TS project prevents the three generated Cloudflare Env declarations
// from contaminating the per-Worker unit-test projects.
afterEach(() => vi.unstubAllGlobals());

async function clickReview(
  testEnv: InteractionRouterEnv,
  discordKey: CryptoKeyPair,
  review: { review_id: string; message_id: string },
  id: string,
) {
  const body = JSON.stringify({
    id,
    application_id: testEnv.DISCORD_APPLICATION_ID,
    token: "fixture-token",
    type: 3,
    guild_id: testEnv.DISCORD_GUILD_ID,
    channel_id: testEnv.DISCORD_APPROVAL_CHANNEL_ID,
    member: { user: { id: testEnv.DISCORD_FORECAST_APPROVER_USER_ID } },
    message: { id: review.message_id },
    data: { custom_id: `forecast_publish:staging:${review.review_id}`, component_type: 2 },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    discordKey.privateKey,
    new TextEncoder().encode(timestamp + body),
  );
  const context = createExecutionContext();
  const response = await router.fetch(
    new Request("https://router.test/discord/interactions", {
      method: "POST",
      body,
      headers: {
        "x-signature-ed25519": hex(signature),
        "x-signature-timestamp": timestamp,
      },
    }),
    testEnv,
    context,
  );
  await waitOnExecutionContext(context);
  expect(await response.json()).toEqual({ type: 5, data: { flags: 0 } });
}

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

it("real ingestion A → delivered review → corrected ingestion B rejects A's signed approval atomically", async () => {
  await reset();
  // D1 enforces ingestion leases with its real SQL clock. Only candidate construction
  // uses the historical notice date; do not fake the lease/signature/guard clocks.
  vi.useRealTimers();
  const testEnv = { ...env } as unknown as InteractionRouterEnv;
  const db = testEnv.STAGING_FORECAST_DB;
  // Use the collector's complete schema, not the publication-only v1 table subset.
  await executeTestSql(db, collectorSchema, applyD1Migrations);
  await executeTestSql(db, versionsMigration, applyD1Migrations);
  await executeTestSql(db, publicationMigration, applyD1Migrations);
  await executeTestSql(db, ingestionMigration, applyD1Migrations);
  await executeTestSql(db, pageMigration, applyD1Migrations);
  await executeTestSql(db, evidenceMigration, applyD1Migrations);
  await executeTestSql(db, grantsMigration, applyD1Migrations);
  await seedNormalUsageGuard(testEnv.USAGE_GUARD_DB);
  const discordKey = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const signing = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  testEnv.DISCORD_PUBLIC_KEY = hex(await crypto.subtle.exportKey("raw", discordKey.publicKey));
  testEnv.FORECAST_PUBLICATION_SIGNING_KEY = encodeBase64(
    new Uint8Array(await crypto.subtle.exportKey("pkcs8", signing.privateKey)),
  );
  const outbound = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toMatch(/^https:\/\/discord\.com\/api\/v10\//);
    return Response.json({ id: "777777777" });
  });
  vi.stubGlobal("fetch", outbound);
  const candidateNowMs = Date.parse("2026-08-20T12:00:00Z");
  const item = await parseNoticeDetail(noticeFixture, 56, "8060044");
  if (!item) throw new Error("fixture_missing");
  const now = new Date().toISOString();
  await db
    .prepare(`INSERT INTO source_queue
    (source,item_id,url,title,published_at,official,status,attempts,first_seen_at,updated_at)
    VALUES(?,?,?,?,?,1,'pending',0,?,?)`)
    .bind(item.source, item.itemId, item.url, item.title, item.publishedAt, now, now)
    .run();
  const collector: CollectorEnv = {
    FORECAST_DB: db,
    USAGE_GUARD_DB: testEnv.USAGE_GUARD_DB,
    ADMIN_TOKEN: "fixture",
    ENVIRONMENT: "staging",
    DEPLOY_SHA: "fixture",
    POLL_MODE: "both",
    RUNTIME_INGESTION_ENABLED: "true",
  };
  const dispatcher = {
    FORECAST_DB: db,
    USAGE_GUARD_DB: testEnv.USAGE_GUARD_DB,
    ENVIRONMENT: "staging",
    DEPLOY_SHA: "fixture",
    DISPATCH_ENABLED: "true",
    PUBLICATION_MODE: "enabled",
    DISCORD_BOT_TOKEN: "fixture",
    DISCORD_APPROVAL_CHANNEL_ID: testEnv.DISCORD_APPROVAL_CHANNEL_ID,
  } as DispatcherEnv;
  expect(
    (
      await runRuntimeIngestion(collector, {
        fetcher: async () => Response.json(noticeFixture),
        candidateNowMs,
      })
    ).candidateCreated,
  ).toBe(true);
  expect(await runDispatcher(dispatcher)).toEqual({ status: "completed", sent: 1 });
  const a = await db
    .prepare(`SELECT r.review_id,r.candidate_id,o.message_id FROM forecast_runtime_reviews r
    JOIN forecast_runtime_outbox o ON o.review_id=r.review_id WHERE r.action='approve' AND o.state='sent'`)
    .first<{ review_id: string; candidate_id: string; message_id: string }>();
  if (!a) throw new Error("delivered_review_missing");
  const corrected = structuredClone(noticeFixture);
  corrected.content.feed.contents = corrected.content.feed.contents.replace("8/27(목)", "8/28(목)");
  expect(corrected.content.feed.contents).not.toBe(noticeFixture.content.feed.contents);
  await db.prepare("UPDATE runtime_ingestion_items SET next_check_at='2000-01-01T00:00:00Z'").run();
  expect(
    (
      await runRuntimeIngestion(collector, {
        fetcher: async () => Response.json(corrected),
        candidateNowMs,
      })
    ).candidateCreated,
  ).toBe(true);
  const candidates = (
    await db
      .prepare("SELECT candidate_id,state FROM forecast_candidates ORDER BY revision")
      .all<{ candidate_id: string; state: string }>()
  ).results;
  expect(candidates).toEqual([
    { candidate_id: a.candidate_id, state: "superseded" },
    { candidate_id: expect.any(String), state: "x_unavailable" },
  ]);
  await clickReview(testEnv, discordKey, a, "5101");
  expect(
    await db
      .prepare("SELECT state,error_code FROM forecast_runtime_commands WHERE interaction_id='5101'")
      .first(),
  ).toEqual({ state: "failed", error_code: "runtime_approval_ineligible" });
  expect(
    await db.prepare("SELECT sequence,candidate_id FROM forecast_runtime_active").first(),
  ).toEqual({ sequence: 0, candidate_id: null });
  expect(await db.prepare("SELECT COUNT(*) n FROM forecast_runtime_approvals").first()).toEqual({
    n: 0,
  });
  expect(
    await db.prepare("SELECT COUNT(*) n FROM forecast_runtime_activation_history").first(),
  ).toEqual({ n: 0 });
  expect(
    await db.prepare("SELECT COUNT(*) n FROM forecast_runtime_outbox WHERE kind='result'").first(),
  ).toEqual({ n: 0 });
  await runDispatcher(dispatcher);
  const b = await db
    .prepare(`SELECT r.review_id,o.message_id FROM forecast_runtime_reviews r
    JOIN forecast_runtime_outbox o ON o.review_id=r.review_id WHERE r.candidate_id=? AND o.state='sent'`)
    .bind(candidates[1]?.candidate_id)
    .first<{ review_id: string; message_id: string }>();
  if (!b) throw new Error("corrected_review_missing");
  await clickReview(testEnv, discordKey, b, "5102");
  expect(
    await db.prepare("SELECT sequence,candidate_id FROM forecast_runtime_active").first(),
  ).toEqual({ sequence: 1, candidate_id: candidates[1]?.candidate_id });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
