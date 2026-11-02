import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { seedNormalUsageGuard } from "../../forecast-collector/src/test-usage-guard.ts";
import { applyPendingDecisions } from "../../forecast-collector/src/v2/rules/pending-decisions.ts";
import {
  configureRules,
  processPostVersion,
} from "../../forecast-collector/src/v2/rules/process.ts";
import { renderForecastV2Notification } from "../../shared/forecastV2Notifications.ts";
import { executeTestSql } from "../../shared/testD1Sql.ts";
import type { InteractionRouterEnv } from "../src/types.ts";
import worker from "../src/worker.ts";
import { v2Baseline, v2Migrations } from "./v2-test-fixture.ts";

const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("");
afterEach(() => vi.unstubAllGlobals());

async function signedClick(testEnv: InteractionRouterEnv, key: CryptoKeyPair, customId: string) {
  const modal = customId.startsWith("fv2m:");
  const body = JSON.stringify({
    id: modal ? "9002" : "9001",
    token: "integration-token",
    application_id: testEnv.DISCORD_APPLICATION_ID,
    type: modal ? 5 : 3,
    guild_id: testEnv.DISCORD_GUILD_ID,
    channel_id: testEnv.DISCORD_APPROVAL_CHANNEL_ID,
    member: { user: { id: testEnv.DISCORD_FORECAST_APPROVER_USER_ID } },
    message: { id: "666666666" },
    data: {
      custom_id: customId,
      component_type: 2,
      ...(modal
        ? {
            components: [
              { component: { custom_id: "start", value: "2026-06-26 12:00" } },
              { component: { custom_id: "end", value: "2026-06-28 05:00" } },
            ],
          }
        : {}),
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key.privateKey,
    new TextEncoder().encode(timestamp + body),
  );
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://router.test/discord/interactions", {
      method: "POST",
      body,
      headers: { "x-signature-ed25519": hex(signature), "x-signature-timestamp": timestamp },
    }),
    testEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response.json<{ type: number; data: { custom_id?: string } }>();
}

it.each([
  { monitor: "A" as const, stale: false },
  { monitor: "A" as const, stale: true },
  { monitor: "B" as const, stale: false },
  { monitor: "B" as const, stale: true },
])("rules → render → signed click → apply $monitor stale=$stale", async ({ monitor, stale }) => {
  await reset();
  const testEnv: InteractionRouterEnv = {
    STAGING_FORECAST_DB: Reflect.get(env, "STAGING_FORECAST_DB"),
    USAGE_GUARD_DB: env.USAGE_GUARD_DB,
    FORECAST_ENVIRONMENT: "staging",
    DISCORD_PUBLIC_KEY: "unset",
    DISCORD_APPLICATION_ID: "123456789",
    DISCORD_GUILD_ID: "222222222",
    DISCORD_FORECAST_APPROVER_USER_ID: "987654321",
    DISCORD_APPROVAL_CHANNEL_ID: "333333333",
    DISCORD_ALERT_CHANNEL_ID: "444444444",
    DISCORD_ACTIVITY_CHANNEL_ID: "555555555",
    DEPLOY_SHA: "integration",
    STAGING_PUBLICATION_MODE: "off",
    PRODUCTION_PUBLICATION_MODE: "off",
    PRODUCTION_MUTATIONS_ENABLED: "false",
    FORECAST_PUBLICATION_KEY_ID: "unset",
  };
  const db = testEnv.STAGING_FORECAST_DB;
  for (const sql of [v2Baseline, ...v2Migrations]) await executeTestSql(db, sql, applyD1Migrations);
  await seedNormalUsageGuard(testEnv.USAGE_GUARD_DB);
  configureRules({ environment: "staging" });
  const now = new Date().toISOString();
  const posted = "2026-06-25T08:00:00.000Z";
  const body =
    monitor === "A"
      ? "전체 지휘관 우편 보상\n보상 지급일: 6/26 00:00\n보상 지급일: 6/27 00:00\n관리 키트 상자 II ×10"
      : "솔로 레이드 재개: 6/26 12:00 ~ 6/28 05:00";
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_monitor_runs
      (run_id,stream_id,generation,kind,status,started_at) VALUES('integration',?,1,'new','completed',?)`)
      .bind(monitor, posted),
    db
      .prepare("INSERT INTO forecast_v2_search_hits VALUES('integration','6252194',?,?,?)")
      .bind(posted, posted, JSON.stringify({ title: "솔로 레이드 보상 및 재개 안내" })),
    db
      .prepare("INSERT INTO forecast_v2_post_versions VALUES('original','6252194',?,?,11,?,?,?)")
      .bind(posted, "a".repeat(64), posted, posted, body),
  ]);
  await processPostVersion(
    db,
    { monitorId: monitor, feedId: "6252194", versionId: "original" },
    Date.parse(now),
  );
  const row = await db
    .prepare(`SELECT q.type,q.expected_calendar_revision,o.kind,o.payload_json,o.idempotency_key,o.outbox_id
    FROM forecast_v2_decision_requests q JOIN forecast_v2_notification_outbox o ON o.decision_id=q.decision_id
    WHERE o.kind=?`)
    .bind(monitor === "A" ? "decision_request" : "b_report")
    .first<{
      type: string;
      expected_calendar_revision: number;
      kind: "decision_request" | "b_report";
      payload_json: string;
      idempotency_key: string;
      outbox_id: string;
    }>();
  if (!row) throw new Error("real_decision_missing");
  expect(row.type).toBe(monitor === "A" ? "grant_date" : "solo_review");
  const rendered = renderForecastV2Notification(row.kind, JSON.parse(row.payload_json), {
    environment: "staging",
    expectedRevision: row.expected_calendar_revision,
    idempotencyKey: row.idempotency_key,
  });
  const button = rendered.components
    .flatMap((r) => r.components)
    .find((b) => b.custom_id.includes(monitor === "A" ? ":opt:" : ":bedit:"));
  if (!button) throw new Error("real_button_missing");
  await db
    .prepare(
      "UPDATE forecast_v2_notification_outbox SET state='sent',message_id='666666666',channel_id=? WHERE outbox_id=?",
    )
    .bind(testEnv.DISCORD_APPROVAL_CHANNEL_ID, row.outbox_id)
    .run();
  if (stale)
    await db
      .prepare("INSERT INTO forecast_v2_post_versions VALUES('newer','6252194',?,?,11,?,?,?)")
      .bind("2026-06-26", "b".repeat(64), posted, now, `${body} 수정`)
      .run();
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  testEnv.DISCORD_PUBLIC_KEY = hex(await crypto.subtle.exportKey("raw", key.publicKey));
  const reply = await signedClick(testEnv, key, button.custom_id);
  expect(reply).toMatchObject(
    stale
      ? { type: 4, data: { content: "공지가 수정되어 이 결정은 더 이상 유효하지 않습니다" } }
      : { type: monitor === "A" ? 7 : 9 },
  );
  if (monitor === "B" && !stale) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    if (!reply.data.custom_id) throw new Error("modal_missing");
    expect(await signedClick(testEnv, key, reply.data.custom_id)).toMatchObject({ type: 6 });
  }
  expect(await applyPendingDecisions(db, Date.parse(now))).toMatchObject({ applied: !stale });
  if (stale) {
    expect(await db.prepare("SELECT COUNT(*) n FROM forecast_v2_decision_results").first("n")).toBe(
      0,
    );
    expect(
      await db.prepare("SELECT COUNT(*) n FROM forecast_v2_consumed_interactions").first("n"),
    ).toBe(0);
  }
  if (monitor === "A") {
    const grants = (
      await db.prepare("SELECT grant_game_day,ii_qty,box_qty FROM forecast_v2_grant_heads").all()
    ).results;
    expect(grants).toEqual(stale ? [] : [{ grant_game_day: "2026-06-25", ii_qty: 10, box_qty: 0 }]);
  } else {
    const calendar = (
      await db
        .prepare(`SELECT r.kind,r.starts_at,r.ends_at FROM forecast_v2_calendar_heads h
      JOIN forecast_v2_calendar_revisions r ON r.event_id=h.event_id AND r.revision=h.revision`)
        .all()
    ).results;
    expect(calendar).toEqual(
      stale
        ? []
        : [
            {
              kind: "solo",
              starts_at: "2026-06-26T03:00:00.000Z",
              ends_at: "2026-06-27T20:00:00.000Z",
            },
          ],
    );
  }
});
