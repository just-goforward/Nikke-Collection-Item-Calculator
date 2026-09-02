import { createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import schemaSql from "../../forecast-collector/schema.sql?raw";
import usageGuardSchemaSql from "../../usage-guard/schema.sql?raw";
import type { InteractionRouterEnv } from "./types";
import worker from "./worker";

const testEnv = env as unknown as InteractionRouterEnv;
const nowMs = Date.parse("2026-09-01T03:00:00.000Z");
let keyPair: CryptoKeyPair;
let publicKeyHex: string;
let webhookFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await reset();
  vi.setSystemTime(nowMs);
  for (const db of [testEnv.STAGING_FORECAST_DB, testEnv.PRODUCTION_FORECAST_DB]) {
    for (const statement of schemaSql
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  for (const statement of usageGuardSchemaSql
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    await testEnv.USAGE_GUARD_DB.prepare(statement).run();
  }
  await testEnv.USAGE_GUARD_DB.prepare(
    `INSERT INTO usage_guard_state (
       singleton_id, action, observed_at, period_start, period_end,
       evidence_json, evidence_hash, current_percent, projected_percent,
       governing_metric, normal_streak, release_pending, updated_at
     ) VALUES (1, 'normal', ?, ?, ?, '{}', ?, 0, 0,
               'workerRequests', 2, 0, ?)`,
  )
    .bind(
      new Date(nowMs).toISOString(),
      "2026-08-15T00:00:00.000Z",
      "2026-09-15T00:00:00.000Z",
      "0".repeat(64),
      new Date(nowMs).toISOString(),
    )
    .run();
  keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  publicKeyHex = bytesHex(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  webhookFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", webhookFetch);
});

describe("Discord interaction router", () => {
  it("answers signed ping and rejects invalid signatures", async () => {
    const ping = await signedInteraction({ type: 1, application_id: "123456789" });
    const invalid = await invoke(
      new Request("https://router.test/discord/interactions", {
        method: "POST",
        headers: {
          "x-signature-ed25519": "00".repeat(64),
          "x-signature-timestamp": String(Math.floor(nowMs / 1_000)),
        },
        body: JSON.stringify({ type: 1, application_id: "123456789" }),
      }),
    );

    expect(await ping.json()).toEqual({ type: 1 });
    expect(invalid.status).toBe(401);
  });

  it("defers an authorized router smoke, audits timing, and rejects replay", async () => {
    const interaction = componentInteraction(
      `forecast_router_test:${"a".repeat(32)}`,
      "987654321",
      "555555555",
      "1001",
    );

    const first = await signedInteraction(interaction);
    const replay = await signedInteraction(interaction);

    expect(await first.json()).toEqual({ type: 6 });
    expect(await replay.json()).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(webhookFetch).toHaveBeenCalledOnce();
    const audit = await testEnv.STAGING_FORECAST_DB.prepare(
      `SELECT action, result, initial_response_ms, replay_count
       FROM discord_interaction_audit WHERE interaction_id = '1001'`,
    ).first<{
      action: string;
      result: string;
      initial_response_ms: number;
      replay_count: number;
    }>();
    expect(audit).toMatchObject({ action: "router_test", result: "completed", replay_count: 1 });
    expect(audit?.initial_response_ms).toBeGreaterThanOrEqual(0);
    expect(audit?.initial_response_ms).toBeLessThan(1_000);
  });

  it("enforces guild, user, and channel authorization before mutation", async () => {
    const reviewId = await insertManualReview(testEnv.STAGING_FORECAST_DB, "200");
    const base = componentInteraction(
      `forecast_manual_staging_ignore:${reviewId}`,
      "987654321",
      "444444444",
      "1002",
    );
    const wrongGuild = await signedInteraction({ ...base, guild_id: "999999999" });
    const wrongUser = await signedInteraction({
      ...base,
      id: "1003",
      member: { user: { id: "111111111" } },
    });
    const wrongChannel = await signedInteraction({ ...base, id: "1004", channel_id: "555555555" });

    for (const response of [wrongGuild, wrongUser, wrongChannel]) {
      expect(await response.json()).toMatchObject({ type: 4, data: { flags: 64 } });
    }
    const review = await testEnv.STAGING_FORECAST_DB.prepare(
      "SELECT state FROM source_manual_reviews WHERE review_id = ?",
    )
      .bind(reviewId)
      .first<{ state: string }>();
    expect(review?.state).toBe("pending");
  });

  it("rejects an unauthorized guild before consulting quota state", async () => {
    await testEnv.USAGE_GUARD_DB.prepare("DELETE FROM usage_guard_state").run();
    const response = await signedInteraction({
      ...componentInteraction(
        `forecast_router_test:${"b".repeat(32)}`,
        "987654321",
        "555555555",
        "1009",
      ),
      guild_id: "999999999",
    });

    expect(await response.json()).toMatchObject({
      type: 4,
      data: { content: "허용된 Discord 서버에서만 처리할 수 있습니다.", flags: 64 },
    });
  });

  it("consults the quota guard before reading a protected Forecast target", async () => {
    await testEnv.USAGE_GUARD_DB.prepare("DELETE FROM usage_guard_state").run();
    await testEnv.STAGING_FORECAST_DB.prepare("DROP TABLE source_manual_reviews").run();

    const response = await signedInteraction(
      componentInteraction(
        `forecast_manual_staging_ignore:mr-${"3".repeat(32)}`,
        "987654321",
        "444444444",
        "1010",
      ),
    );

    expect(await response.json()).toMatchObject({
      type: 4,
      data: {
        content: "Cloudflare 월간 예산 보호 상태(hard_stop)로 Forecast 변경이 중단되었습니다.",
        flags: 64,
      },
    });
  });

  it("cannot use a staging custom ID to mutate the production database", async () => {
    const reviewId = await insertManualReview(testEnv.PRODUCTION_FORECAST_DB, "201");
    const stagingAttempt = await signedInteraction(
      componentInteraction(
        `forecast_manual_staging_ignore:${reviewId}`,
        "987654321",
        "444444444",
        "1005",
      ),
    );
    expect(await stagingAttempt.json()).toMatchObject({ type: 4, data: { flags: 64 } });
    await expect(reviewState(testEnv.PRODUCTION_FORECAST_DB, reviewId)).resolves.toBe("pending");

    const disabledProductionAttempt = await signedInteraction(
      componentInteraction(
        `forecast_manual_production_ignore:${reviewId}`,
        "987654321",
        "444444444",
        "1006",
      ),
    );
    expect(await disabledProductionAttempt.json()).toMatchObject({ type: 4, data: { flags: 64 } });
    await expect(reviewState(testEnv.PRODUCTION_FORECAST_DB, reviewId)).resolves.toBe("pending");

    const productionAttempt = await signedInteraction(
      componentInteraction(
        `forecast_manual_production_ignore:${reviewId}`,
        "987654321",
        "444444444",
        "1006",
      ),
      { PRODUCTION_MUTATIONS_ENABLED: "true" },
    );
    expect(await productionAttempt.json()).toEqual({ type: 6 });
    await expect(reviewState(testEnv.PRODUCTION_FORECAST_DB, reviewId)).resolves.toBe("resolved");
    await expect(reviewState(testEnv.STAGING_FORECAST_DB, reviewId)).resolves.toBeUndefined();
  });

  it("can repair a completed manual-review card after the first webhook update fails", async () => {
    const reviewId = await insertManualReview(testEnv.STAGING_FORECAST_DB, "202");
    const customId = `forecast_manual_staging_ignore:${reviewId}`;
    webhookFetch
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const first = await signedInteraction(
      componentInteraction(customId, "987654321", "444444444", "1007"),
    );
    expect(await first.json()).toEqual({ type: 6 });
    await expect(reviewState(testEnv.STAGING_FORECAST_DB, reviewId)).resolves.toBe("resolved");

    const retry = await signedInteraction(
      componentInteraction(customId, "987654321", "444444444", "1008"),
    );
    expect(await retry.json()).toEqual({ type: 6 });
    expect(webhookFetch).toHaveBeenCalledTimes(2);
    const audit = await testEnv.STAGING_FORECAST_DB.prepare(
      "SELECT result FROM discord_interaction_audit WHERE interaction_id = '1008'",
    ).first<{ result: string }>();
    expect(audit?.result).toBe("completed");
  });
});

async function insertManualReview(db: D1Database, itemId: string) {
  const now = new Date(nowMs).toISOString();
  const reviewId = `mr-${itemId.padStart(32, "0")}`;
  await db
    .prepare(
      `INSERT INTO source_queue (
       source, item_id, url, title, published_at, official, status, attempts,
       review_generation, error_code, first_seen_at, updated_at
     ) VALUES ('naver-board-56', ?, ?, ?, ?, 1, 'manual_review', 3, 0,
       'schedule_ambiguous', ?, ?)`,
    )
    .bind(
      itemId,
      `https://game.naver.com/lounge/nikke/board/detail/${itemId}`,
      `공지 ${itemId}`,
      now,
      now,
      now,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO source_manual_reviews (
       review_id, source, item_id, generation, state, created_at, expires_at
     ) VALUES (?, 'naver-board-56', ?, 0, 'pending', ?, ?)`,
    )
    .bind(reviewId, itemId, now, new Date(nowMs + 24 * 60 * 60 * 1_000).toISOString())
    .run();
  return reviewId;
}

async function reviewState(db: D1Database, reviewId: string) {
  const row = await db
    .prepare("SELECT state FROM source_manual_reviews WHERE review_id = ?")
    .bind(reviewId)
    .first<{ state: string }>();
  return row?.state;
}

async function signedInteraction(value: unknown, overrides: Partial<InteractionRouterEnv> = {}) {
  const body = JSON.stringify(value);
  const timestamp = String(Math.floor(nowMs / 1_000));
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    keyPair.privateKey,
    new TextEncoder().encode(`${timestamp}${body}`),
  );
  return invoke(
    new Request("https://router.test/discord/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": bytesHex(signature),
        "x-signature-timestamp": timestamp,
      },
      body,
    }),
    overrides,
  );
}

function componentInteraction(customId: string, userId: string, channelId: string, id: string) {
  return {
    id,
    application_id: "123456789",
    token: `interaction-token-${id}`,
    type: 3,
    guild_id: "222222222",
    channel_id: channelId,
    member: { user: { id: userId } },
    data: { custom_id: customId, component_type: 2 },
  };
}

async function invoke(request: Request, overrides: Partial<InteractionRouterEnv> = {}) {
  const handler = worker.fetch;
  if (!handler) throw new Error("Missing Router fetch handler.");
  const context = createExecutionContext();
  const response = await handler(
    request as Parameters<typeof handler>[0],
    { ...testEnv, DISCORD_PUBLIC_KEY: publicKeyHex, ...overrides },
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

function bytesHex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
