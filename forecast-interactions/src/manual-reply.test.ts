import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  migratePublicationDb,
  seedManualReview,
  TEST_NOW,
} from "../../shared/forecast-publication/test-fixtures.ts";
import { executeTestSql } from "../../shared/testD1Sql.ts";
import usageSchema from "../../usage-guard/schema.sql?raw";
import type { InteractionRouterEnv } from "./types.ts";
import worker from "./worker.ts";

let testEnv: InteractionRouterEnv;
let discord: ReturnType<typeof vi.fn>;
let discordKey: CryptoKeyPair;
beforeEach(async () => {
  await reset();
  vi.setSystemTime(TEST_NOW);
  testEnv = { ...(env as InteractionRouterEnv), DISCORD_BOT_TOKEN: "bot-secret" };
  await migratePublicationDb(testEnv.STAGING_FORECAST_DB, applyD1Migrations);
  await executeTestSql(testEnv.USAGE_GUARD_DB, usageSchema, applyD1Migrations);
  await testEnv.USAGE_GUARD_DB.prepare(`INSERT INTO usage_guard_state
    (singleton_id,action,observed_at,period_start,period_end,evidence_json,evidence_hash,
    current_percent,projected_percent,governing_metric,normal_streak,release_pending,updated_at)
    VALUES(1,'normal',?,'2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','{}',?,0,0,'workerRequests',2,0,?)`)
    .bind(new Date(TEST_NOW).toISOString(), "0".repeat(64), new Date(TEST_NOW).toISOString())
    .run();
  discordKey = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  testEnv.DISCORD_PUBLIC_KEY = hex(await crypto.subtle.exportKey("raw", discordKey.publicKey));
  discord = vi.fn().mockImplementation(async () => Response.json({ id: "777777777" }));
  vi.stubGlobal("fetch", discord);
});

async function confirmIgnore() {
  const { reviewId } = await seedManualReview(testEnv.STAGING_FORECAST_DB, true);
  const body = JSON.stringify({
    id: "1001",
    application_id: testEnv.DISCORD_APPLICATION_ID,
    token: "test-token",
    type: 3,
    guild_id: testEnv.DISCORD_GUILD_ID,
    channel_id: testEnv.DISCORD_ALERT_CHANNEL_ID,
    member: { user: { id: testEnv.DISCORD_FORECAST_APPROVER_USER_ID } },
    message: { id: "666666666", embeds: [{ title: "Forecast 수동 검토 필요" }] },
    data: { custom_id: `forecast_manual_staging_ignore_confirm:${reviewId}`, component_type: 2 },
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    discordKey.privateKey,
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
  expect(await response.json()).toEqual({ type: 6 });
  await waitOnExecutionContext(context);
  return discord.mock.calls.map(([url, init]) => ({
    url: String(url),
    init: init as RequestInit & { headers: Record<string, string> },
    body: JSON.parse(String((init as RequestInit).body)),
  }));
}

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("manual-review native reply", () => {
  it("posts the completion notice as a native reply when a bot token is configured", async () => {
    const calls = await confirmIgnore();
    expect(calls.map((call) => call.init.method)).toEqual(["PATCH", "POST"]);
    expect(calls[0]?.init.headers["authorization"]).toBeUndefined();
    expect(calls[1]?.url).toBe(
      `https://discord.com/api/v10/channels/${testEnv.DISCORD_ALERT_CHANNEL_ID}/messages`,
    );
    expect(calls[1]?.init.headers["authorization"]).toBe("Bot bot-secret");
    expect(calls[1]?.init.redirect).toBe("manual");
    expect(calls[1]?.body).toMatchObject({
      content: expect.stringContaining("관련 없음으로 처리했습니다."),
      message_reference: { message_id: "666666666", fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: false },
    });
  });

  it("falls back to the interaction webhook when the reply is rejected", async () => {
    discord.mockImplementation(async (url) =>
      String(url).includes("/channels/")
        ? new Response(null, { status: 302, headers: { location: "https://example.com/" } })
        : new Response(null, { status: 204 }),
    );
    const urls = (await confirmIgnore()).map((call) => call.url);
    expect(urls).toHaveLength(3);
    expect(urls[1]).toContain("/channels/");
    expect(urls[2]).toMatch(/\/webhooks\/.+\/test-token$/);
    expect(urls.some((url) => url.includes("example.com"))).toBe(false);
    expect(
      await testEnv.STAGING_FORECAST_DB.prepare(
        "SELECT result,error_code FROM discord_interaction_audit",
      ).first(),
    ).toEqual({ result: "completed", error_code: "manual_review_discord_reply_failed" });
  });

  it("does not post a second notice when the reply outcome is unknown", async () => {
    discord.mockImplementation(async (url) =>
      String(url).includes("/channels/")
        ? new Response(null, { status: 503 })
        : new Response(null, { status: 204 }),
    );
    const urls = (await confirmIgnore()).map((call) => call.url);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("/channels/");
    expect(
      await testEnv.STAGING_FORECAST_DB.prepare(
        "SELECT error_code FROM discord_interaction_audit",
      ).first(),
    ).toEqual({ error_code: "manual_review_discord_server_failed" });
  });
});
