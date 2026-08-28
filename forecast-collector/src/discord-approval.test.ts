import { createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import discordApprovalMigrationSql from "../migrations/0004_discord_approval_tests.sql?raw";
import schemaSql from "../schema.sql?raw";
import type { CollectorEnv } from "./types";
import worker from "./worker";

const testEnv = env as unknown as CollectorEnv;
const nowMs = Date.parse("2026-08-27T00:00:00.000Z");
let keyPair: CryptoKeyPair;
let publicKeyHex: string;

beforeEach(async () => {
  await reset();
  await executeSql(schemaSql);
  keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  publicKeyHex = bytesHex(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  vi.setSystemTime(nowMs);
});

describe("Discord forecast approval test boundary", () => {
  it("applies migration 0004 to an existing collector database", async () => {
    await testEnv.FORECAST_DB.prepare("DROP TABLE discord_approval_tests").run();
    await testEnv.FORECAST_DB.prepare("DELETE FROM schema_migrations WHERE version = 4").run();

    await executeSql(discordApprovalMigrationSql);

    const migration = await testEnv.FORECAST_DB.prepare(
      "SELECT version FROM schema_migrations WHERE version = 4",
    ).first<{ version: number }>();
    const table = await testEnv.FORECAST_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discord_approval_tests'",
    ).first<{ name: string }>();
    expect(migration?.version).toBe(4);
    expect(table?.name).toBe("discord_approval_tests");
  });

  it("answers a correctly signed Discord PING without touching approval state", async () => {
    const response = await signedInteraction({ type: 1, application_id: "123456789" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("records one authorized test approval and makes replay idempotent", async () => {
    const approval = await createApproval();
    const interaction = componentInteraction(approval.customId, "987654321", "1001");

    const approved = await signedInteraction(interaction);
    const replayed = await signedInteraction(interaction);
    const stored = await testEnv.FORECAST_DB.prepare(
      `SELECT state, approver_user_id, interaction_id
       FROM discord_approval_tests WHERE approval_id = ?`,
    )
      .bind(approval.approvalId)
      .first<{ state: string; approver_user_id: string; interaction_id: string }>();

    expect(await approved.json()).toMatchObject({
      type: 7,
      data: {
        components: [
          {
            components: [
              { label: "확인 완료 (테스트)", disabled: true },
              {
                label: "GitHub PR 열기",
                url: "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/12",
              },
            ],
          },
        ],
      },
    });
    expect(await replayed.json()).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(stored).toEqual({
      state: "test_approved",
      approver_user_id: "987654321",
      interaction_id: "1001",
    });
  });

  it("rejects another Discord user without changing the pending record", async () => {
    const approval = await createApproval();
    const response = await signedInteraction(
      componentInteraction(approval.customId, "111111111", "1002"),
    );
    const stored = await approvalState(approval.approvalId);

    expect(await response.json()).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(stored).toBe("pending");
  });

  it("rejects an invalid or stale Discord signature", async () => {
    const body = JSON.stringify({ type: 1, application_id: "123456789" });
    const invalid = await invoke(
      new Request("https://collector.test/discord/interactions", {
        method: "POST",
        headers: {
          "x-signature-ed25519": "00".repeat(64),
          "x-signature-timestamp": String(Math.floor(nowMs / 1000)),
        },
        body,
      }),
    );
    const stale = await signedInteraction(
      { type: 1, application_id: "123456789" },
      nowMs - 6 * 60 * 1000,
    );

    expect(invalid.status).toBe(401);
    expect(stale.status).toBe(401);
  });

  it("expires a pending button and never updates a forecast candidate or PR", async () => {
    const approval = await createApproval();
    await testEnv.FORECAST_DB.prepare(
      "UPDATE discord_approval_tests SET expires_at = ? WHERE approval_id = ?",
    )
      .bind(new Date(nowMs - 1).toISOString(), approval.approvalId)
      .run();

    const response = await signedInteraction(
      componentInteraction(approval.customId, "987654321", "1003"),
    );

    expect(await response.json()).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(await approvalState(approval.approvalId)).toBe("expired");
    const candidates = await testEnv.FORECAST_DB.prepare(
      "SELECT COUNT(*) AS count FROM forecast_candidates",
    ).first<{ count: number }>();
    expect(candidates?.count).toBe(0);
  });

  it("keeps both registration and interactions unavailable in production mode", async () => {
    const production = configuredEnv({ ENVIRONMENT: "production" });
    const registration = await invokeAdmin(production);
    const interaction = await signedInteraction(
      { type: 1, application_id: "123456789" },
      nowMs,
      production,
    );

    expect(registration.status).toBe(404);
    expect(interaction.status).toBe(404);
  });
});

async function createApproval() {
  const response = await invokeAdmin(configuredEnv());
  expect(response.status).toBe(200);
  return response.json<{
    approvalId: string;
    customId: string;
    expiresAt: string;
  }>();
}

async function invokeAdmin(targetEnv = configuredEnv()) {
  return invoke(
    new Request("https://collector.test/admin/discord-test-approvals", {
      method: "POST",
      headers: {
        authorization: "Bearer test-forecast-admin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestKey: "a".repeat(64),
        candidateId: "forecast-discord-test-12",
        forecastId: "supply-discord-test-v1",
        payloadHash: "b".repeat(64),
        pullRequestNumber: 12,
        pullRequestUrl:
          "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/12",
        headSha: "c".repeat(40),
      }),
    }),
    targetEnv,
  );
}

async function signedInteraction(value: unknown, signedAtMs = nowMs, targetEnv = configuredEnv()) {
  const body = JSON.stringify(value);
  const timestamp = String(Math.floor(signedAtMs / 1000));
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    keyPair.privateKey,
    new TextEncoder().encode(`${timestamp}${body}`),
  );
  return invoke(
    new Request("https://collector.test/discord/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": bytesHex(signature),
        "x-signature-timestamp": timestamp,
      },
      body,
    }),
    targetEnv,
  );
}

function componentInteraction(customId: string, userId: string, interactionId: string) {
  return {
    id: interactionId,
    application_id: "123456789",
    type: 3,
    guild_id: "222222222",
    channel_id: "333333333",
    member: { user: { id: userId } },
    data: { custom_id: customId, component_type: 2 },
  };
}

function configuredEnv(overrides: Partial<CollectorEnv> = {}): CollectorEnv {
  return {
    ...testEnv,
    ADMIN_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as RateLimit,
    ADMIN_TOKEN: "test-forecast-admin-token",
    ENVIRONMENT: "test",
    DEPLOY_SHA: "test-deploy-sha",
    POLL_MODE: "both",
    DISCORD_APPROVAL_MODE: "test",
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_APPLICATION_ID: "123456789",
    DISCORD_APPROVER_USER_ID: "987654321",
    DISCORD_GUILD_ID: "222222222",
    DISCORD_CHANNEL_ID: "333333333",
    ...overrides,
  };
}

async function invoke(request: Request, targetEnv = configuredEnv()) {
  const handler = worker.fetch;
  if (!handler) throw new Error("Missing Worker fetch handler.");
  return handler(request as Parameters<typeof handler>[0], targetEnv, createExecutionContext());
}

async function approvalState(approvalId: string) {
  const stored = await testEnv.FORECAST_DB.prepare(
    "SELECT state FROM discord_approval_tests WHERE approval_id = ?",
  )
    .bind(approvalId)
    .first<{ state: string }>();
  return stored?.state;
}

function bytesHex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function executeSql(sql: string) {
  for (const statement of sql
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    await testEnv.FORECAST_DB.prepare(statement).run();
  }
}
