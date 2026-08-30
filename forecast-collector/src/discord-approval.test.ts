import { createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import discordApprovalMigrationSql from "../migrations/0004_discord_approval_tests.sql?raw";
import discordStagingAdoptionMigrationSql from "../migrations/0005_discord_staging_adoptions.sql?raw";
import discordStagingMessageMigrationSql from "../migrations/0006_discord_staging_message_identity.sql?raw";
import schemaSql from "../schema.sql?raw";
import type { CollectorEnv } from "./types";
import worker from "./worker";

const testEnv = env as unknown as CollectorEnv;
const nowMs = Date.parse("2026-08-27T00:00:00.000Z");
let keyPair: CryptoKeyPair;
let publicKeyHex: string;
let discordEditFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await reset();
  await executeSql(schemaSql);
  keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  publicKeyHex = bytesHex(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  discordEditFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", discordEditFetch);
  vi.setSystemTime(nowMs);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("keeps staging adoption registration and interactions unavailable in production", async () => {
    const production = configuredEnv({
      ENVIRONMENT: "production",
      DISCORD_APPROVAL_MODE: "disabled",
    });
    const registration = await invoke(
      new Request("https://collector.test/admin/discord-staging-adoptions", {
        method: "GET",
        headers: { authorization: "Bearer test-forecast-admin-token" },
      }),
      production,
    );
    const interaction = await signedInteraction(
      { type: 1, application_id: "123456789" },
      nowMs,
      production,
    );

    expect(registration.status).toBe(404);
    expect(interaction.status).toBe(404);
  });

  it("applies staging Discord migrations and records an adoption without product activation", async () => {
    await testEnv.FORECAST_DB.prepare("DROP TABLE discord_staging_adoptions").run();
    await testEnv.FORECAST_DB.prepare(
      "DELETE FROM schema_migrations WHERE version IN (5, 6)",
    ).run();
    await executeSql(discordStagingAdoptionMigrationSql);
    await executeSql(discordStagingMessageMigrationSql);

    const registration = await createStagingAdoption();
    const messageIdentity = await invokeStagingAdmin(
      `https://collector.test/admin/discord-staging-adoptions/${registration.approvalId}/message`,
      {
        method: "POST",
        body: JSON.stringify({
          discordChannelId: "333333333",
          discordMessageId: "444444444",
        }),
      },
    );
    const interaction = componentInteraction(registration.customId, "987654321", "2001");
    const approved = await signedInteraction(
      interaction,
      nowMs,
      configuredEnv({ DISCORD_APPROVAL_MODE: "staging_adoption" }),
    );
    const listed = await invokeStagingAdmin(
      "https://collector.test/admin/discord-staging-adoptions?limit=5",
      { method: "GET" },
    );
    const adoptionPr = await invokeStagingAdmin(
      `https://collector.test/admin/discord-staging-adoptions/${registration.approvalId}/adoption-pr`,
      {
        method: "POST",
        body: JSON.stringify({
          adoptionPullRequestNumber: 14,
          adoptionPullRequestUrl:
            "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/14",
          stagingUrl: "https://nikkecollection.com/?statsEnv=staging",
        }),
      },
    );

    expect(await messageIdentity.json()).toMatchObject({
      adoption: { discordChannelId: "333333333", discordMessageId: "444444444" },
    });
    const approvedResponse = await approved.json<{
      type: number;
      data: { content: string; components: Array<{ components: Array<Record<string, unknown>> }> };
    }>();
    expect(approvedResponse.type).toBe(7);
    expect(approvedResponse.data.content).toContain("기본 production 환경은 변경되지 않습니다");
    expect(approvedResponse.data.content).toContain("nikkecollection.com/?statsEnv=staging");
    expect(approvedResponse.data.components[0]?.components[0]).toMatchObject({
      label: "staging 적용 승인 완료",
      disabled: true,
    });
    expect(discordEditFetch).not.toHaveBeenCalled();
    expect(await listed.json()).toMatchObject({
      adoptions: [{ approvalId: registration.approvalId, state: "approved" }],
    });
    expect(await adoptionPr.json()).toMatchObject({
      adoption: {
        state: "adoption_pr_created",
        adoptionPullRequestNumber: 14,
      },
    });
    const forecasts = await testEnv.FORECAST_DB.prepare(
      "SELECT COUNT(*) AS count FROM forecast_candidates",
    ).first<{ count: number }>();
    expect(forecasts?.count).toBe(0);
  });

  it("reuses an active staging approval across registry revisions", async () => {
    const first = await createStagingAdoption();
    const second = await createStagingAdoption({
      requestKey: "c".repeat(64),
      payloadHash: "9".repeat(64),
      registrySha: "8".repeat(40),
    });

    expect(second.approvalId).toBe(first.approvalId);
  });

  it("expires an old pending staging card and issues a new approval", async () => {
    const first = await createStagingAdoption();
    await testEnv.FORECAST_DB.prepare(
      "UPDATE discord_staging_adoptions SET expires_at = ? WHERE approval_id = ?",
    )
      .bind(new Date(nowMs - 1).toISOString(), first.approvalId)
      .run();

    const second = await createStagingAdoption({ requestKey: "c".repeat(64) });
    const oldState = await stagingAdoptionState(first.approvalId);

    expect(second.approvalId).not.toBe(first.approvalId);
    expect(oldState).toBe("expired");
  });

  it("keeps an approved staging adoption processable after the card TTL", async () => {
    const approval = await createStagingAdoption();
    await signedInteraction(
      componentInteraction(approval.customId, "987654321", "2051"),
      nowMs,
      configuredEnv({ DISCORD_APPROVAL_MODE: "staging_adoption" }),
    );
    await testEnv.FORECAST_DB.prepare(
      "UPDATE discord_staging_adoptions SET expires_at = ? WHERE approval_id = ?",
    )
      .bind(new Date(nowMs - 1).toISOString(), approval.approvalId)
      .run();

    const listed = await invokeStagingAdmin(
      "https://collector.test/admin/discord-staging-adoptions?limit=5",
      { method: "GET" },
    );

    expect(await listed.json()).toMatchObject({
      adoptions: [{ approvalId: approval.approvalId, state: "approved" }],
    });
  });

  it("processes a legacy duplicate payload only once", async () => {
    const first = await createStagingAdoption();
    const duplicateApprovalId = "discord-staging-11111111-1111-4111-8111-111111111111";
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO discord_staging_adoptions (
         approval_id, request_key, forecast_id, payload_hash,
         source_pull_request_number, source_pull_request_url, source_head_sha,
         registry_sha, research_run_id, research_run_url,
         research_artifact_name, research_artifact_digest,
         state, created_at, expires_at
       )
       SELECT ?, ?, forecast_id, ?,
         source_pull_request_number, source_pull_request_url, source_head_sha,
         ?, research_run_id, research_run_url,
         research_artifact_name, research_artifact_digest,
         'pending', ?, expires_at
       FROM discord_staging_adoptions WHERE approval_id = ?`,
    )
      .bind(
        duplicateApprovalId,
        "c".repeat(64),
        "9".repeat(64),
        "8".repeat(40),
        "2026-08-27T00:00:01.000Z",
        first.approvalId,
      )
      .run();
    await signedInteraction(
      componentInteraction(first.customId, "987654321", "2101"),
      nowMs,
      configuredEnv({ DISCORD_APPROVAL_MODE: "staging_adoption" }),
    );
    await signedInteraction(
      componentInteraction(`forecast_staging_approve:${duplicateApprovalId}`, "987654321", "2102"),
      nowMs,
      configuredEnv({ DISCORD_APPROVAL_MODE: "staging_adoption" }),
    );

    const listed = await invokeStagingAdmin(
      "https://collector.test/admin/discord-staging-adoptions?limit=5",
      { method: "GET" },
    );
    expect(await listed.json()).toMatchObject({
      adoptions: [{ approvalId: first.approvalId }],
    });

    await invokeStagingAdmin(
      `https://collector.test/admin/discord-staging-adoptions/${first.approvalId}/adoption-pr`,
      {
        method: "POST",
        body: JSON.stringify({
          adoptionPullRequestNumber: 14,
          adoptionPullRequestUrl:
            "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/14",
          stagingUrl: "https://nikkecollection.com/?statsEnv=staging",
        }),
      },
    );
    const afterProcessing = await invokeStagingAdmin(
      "https://collector.test/admin/discord-staging-adoptions?limit=5",
      { method: "GET" },
    );
    expect(await afterProcessing.json()).toEqual({ adoptions: [] });
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
        content: expect.stringContaining("Discord 승인 응답 테스트가 완료되었습니다"),
        components: [
          {
            components: [
              { label: "테스트 승인 완료", disabled: true },
              {
                label: "GitHub PR 열기",
                url: "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/12",
              },
            ],
          },
        ],
      },
    });
    expect(await replayed.json()).toMatchObject({ type: 7 });
    expect(discordEditFetch).not.toHaveBeenCalled();
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

    expect(await response.json()).toMatchObject({
      type: 7,
      data: { content: expect.stringContaining("만료"), components: [] },
    });
    expect(await approvalState(approval.approvalId)).toBe("expired");
    expect(discordEditFetch).not.toHaveBeenCalled();
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

  it("allows test-only approvals beside staging adoption without changing forecast state", async () => {
    const staging = configuredEnv({ DISCORD_APPROVAL_MODE: "staging_adoption" });
    const registration = await invokeAdmin(staging);
    expect(registration.status).toBe(200);
    const approval = await registration.json<{ approvalId: string; customId: string }>();

    const response = await signedInteraction(
      componentInteraction(approval.customId, "987654321", "1004"),
      nowMs,
      staging,
    );
    const candidates = await testEnv.FORECAST_DB.prepare(
      "SELECT COUNT(*) AS count FROM forecast_candidates",
    ).first<{ count: number }>();
    const adoptions = await testEnv.FORECAST_DB.prepare(
      "SELECT COUNT(*) AS count FROM discord_staging_adoptions",
    ).first<{ count: number }>();

    const responseBody = await response.json<{
      type: number;
      data: { components: Array<{ components: Array<Record<string, unknown>> }> };
    }>();
    expect(responseBody.type).toBe(7);
    expect(responseBody.data).toMatchObject({
      content: expect.stringContaining("Discord 승인 응답 테스트가 완료되었습니다"),
    });
    expect(responseBody.data.components[0]?.components[0]).toMatchObject({
      label: "테스트 승인 완료",
      disabled: true,
    });
    expect(await approvalState(approval.approvalId)).toBe("test_approved");
    expect(candidates?.count).toBe(0);
    expect(adoptions?.count).toBe(0);
    expect(discordEditFetch).not.toHaveBeenCalled();
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

async function createStagingAdoption(overrides: Record<string, unknown> = {}) {
  const response = await invokeStagingAdmin(
    "https://collector.test/admin/discord-staging-adoptions",
    {
      method: "POST",
      body: JSON.stringify({
        requestKey: "d".repeat(64),
        forecastId: "supply-2026-08-28-v1",
        payloadHash: "e".repeat(64),
        sourcePullRequestNumber: 13,
        sourcePullRequestUrl:
          "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/13",
        sourceHeadSha: "f".repeat(40),
        registrySha: "a".repeat(40),
        researchRunId: 33287505614,
        researchRunUrl:
          "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/33287505614",
        researchArtifactName: "dynamic-hp-exact-gate-summary-33287505614",
        researchArtifactDigest: "b".repeat(64),
        ...overrides,
      }),
    },
  );
  expect(response.status).toBe(200);
  return response.json<{ approvalId: string; customId: string }>();
}

async function stagingAdoptionState(approvalId: string) {
  const row = await testEnv.FORECAST_DB.prepare(
    "SELECT state FROM discord_staging_adoptions WHERE approval_id = ?",
  )
    .bind(approvalId)
    .first<{ state: string }>();
  return row?.state;
}

async function invokeStagingAdmin(url: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer test-forecast-admin-token");
  if (init.body) headers.set("content-type", "application/json");
  return invoke(
    new Request(url, { ...init, headers }),
    configuredEnv({ DISCORD_APPROVAL_MODE: "staging_adoption" }),
  );
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
    token: `interaction-token-${interactionId}`,
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
  const context = createExecutionContext();
  const response = await handler(request as Parameters<typeof handler>[0], targetEnv, context);
  await waitOnExecutionContext(context);
  return response;
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
