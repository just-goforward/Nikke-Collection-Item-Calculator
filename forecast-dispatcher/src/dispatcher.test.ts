import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schemaSql from "../../forecast-collector/schema.sql?raw";
import { recordWorkflowDispatchStatus } from "../../forecast-collector/src/ops";
import { runDispatcher } from "./dispatcher";
import type { DispatcherEnv } from "./types";

const testEnv = env as unknown as DispatcherEnv;

beforeEach(async () => {
  await reset();
  for (const statement of schemaSql
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    await testEnv.FORECAST_DB.prepare(statement).run();
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("forecast dispatcher orchestration", () => {
  it("records one accepted workflow request and one Discord notification", async () => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO source_queue (
         source, item_id, url, title, published_at, official, status,
         attempts, first_seen_at, updated_at
       ) VALUES ('naver-board-56', '100', ?, '솔로 레이드 안내', ?, 1, 'pending', 0, ?, ?)`,
    )
      .bind("https://game.naver.com/lounge/nikke/board/detail/100", nowIso, nowIso, nowIso)
      .run();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_test_installation_token_1234567890" }, { status: 201 });
      }
      if (url.includes("/dispatches")) return new Response(null, { status: 204 });
      if (url.includes("discord.com/api/v10/channels/")) {
        return Response.json({ id: "987654321098765432" }, { status: 200 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeEnv = {
      ...testEnv,
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      DISCORD_ACTIVITY_CHANNEL_ID: "222222222222222222",
      DISCORD_ALERT_CHANNEL_ID: "333333333333333333",
      DISCORD_FALLBACK_CHANNEL_ID: "123456789012345678",
      DISPATCH_ENABLED: "true",
    } satisfies DispatcherEnv;

    const result = await runDispatcher(runtimeEnv, { scheduledTime: now });

    expect(result).toMatchObject({ status: "completed", actionableCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/channels/222222222222222222/messages"),
      ),
    ).toBe(true);
    const dispatch = await testEnv.FORECAST_DB.prepare(
      `SELECT state, github_http_status, discord_message_id, dispatcher_deployment_sha
       FROM workflow_dispatches`,
    ).first<{
      state: string;
      github_http_status: number;
      discord_message_id: string;
      dispatcher_deployment_sha: string;
    }>();
    expect(dispatch).toEqual({
      state: "accepted",
      github_http_status: 204,
      discord_message_id: "987654321098765432",
      dispatcher_deployment_sha: "test-dispatcher-sha",
    });
    const invocation = await testEnv.FORECAST_DB.prepare(
      "SELECT status, actionable_count FROM dispatcher_invocations",
    ).first<{ status: string; actionable_count: number }>();
    expect(invocation).toEqual({ status: "completed", actionable_count: 1 });
  });

  it("lets only the first delivery of one scheduled invocation dispatch work", async () => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO source_queue (
         source, item_id, url, title, published_at, official, status,
         attempts, first_seen_at, updated_at
       ) VALUES ('naver-board-56', 'duplicate-100', ?, '중복 Cron 안내', ?, 1, 'pending', 0, ?, ?)`,
    )
      .bind(
        "https://game.naver.com/lounge/nikke/board/detail/duplicate-100",
        nowIso,
        nowIso,
        nowIso,
      )
      .run();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_test_installation_token_1234567890" }, { status: 201 });
      }
      if (url.includes("/dispatches")) return new Response(null, { status: 204 });
      if (url.includes("discord.com/api/v10/channels/")) {
        return Response.json({ id: "987654321098765433" }, { status: 200 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeEnv = {
      ...testEnv,
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      DISCORD_ACTIVITY_CHANNEL_ID: "222222222222222222",
      DISCORD_ALERT_CHANNEL_ID: "333333333333333333",
      DISCORD_FALLBACK_CHANNEL_ID: "123456789012345678",
      DISPATCH_ENABLED: "true",
    } satisfies DispatcherEnv;

    const results = await Promise.all([
      runDispatcher(runtimeEnv, { scheduledTime: now }),
      runDispatcher(runtimeEnv, { scheduledTime: now }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["completed", "duplicate"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const invocations = await testEnv.FORECAST_DB.prepare(
      "SELECT COUNT(*) AS count FROM dispatcher_invocations",
    ).first<{ count: number }>();
    const dispatches = await testEnv.FORECAST_DB.prepare(
      "SELECT COUNT(*) AS count FROM workflow_dispatches",
    ).first<{ count: number }>();
    expect(invocations?.count).toBe(1);
    expect(dispatches?.count).toBe(1);
  });

  it("uses an early workflow callback as proof when the dispatch response is lost", async () => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO source_queue (
         source, item_id, url, title, published_at, official, status,
         attempts, first_seen_at, updated_at
       ) VALUES ('naver-board-56', 'callback-race', ?, '콜백 경합 안내', ?, 1, 'pending', 0, ?, ?)`,
    )
      .bind(
        "https://game.naver.com/lounge/nikke/board/detail/callback-race",
        nowIso,
        nowIso,
        nowIso,
      )
      .run();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_test_installation_token_1234567890" }, { status: 201 });
      }
      if (url.includes("/dispatches")) {
        const row = await testEnv.FORECAST_DB.prepare(
          "SELECT dispatch_id FROM workflow_dispatches WHERE state = 'reserved'",
        ).first<{ dispatch_id: string }>();
        if (!row) throw new Error("Expected an in-flight reservation.");
        await recordWorkflowDispatchStatus(
          testEnv.FORECAST_DB,
          "staging",
          row.dispatch_id,
          {
            phase: "started",
            runId: 777,
            runAttempt: 1,
            runUrl:
              "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/777",
          },
          now + 1_000,
        );
        throw new TypeError("simulated response loss");
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeEnv = {
      ...testEnv,
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      DISCORD_ACTIVITY_CHANNEL_ID: "222222222222222222",
      DISCORD_ALERT_CHANNEL_ID: "333333333333333333",
      DISCORD_FALLBACK_CHANNEL_ID: "123456789012345678",
      DISPATCH_ENABLED: "true",
    } satisfies DispatcherEnv;

    const result = await runDispatcher(runtimeEnv, { scheduledTime: now });

    expect(result).toMatchObject({ status: "completed", actionableCount: 1 });
    const dispatch = await testEnv.FORECAST_DB.prepare(
      "SELECT state, github_run_id, error_code FROM workflow_dispatches",
    ).first<{ state: string; github_run_id: number; error_code: string | null }>();
    expect(dispatch).toEqual({ state: "running", github_run_id: 777, error_code: null });
    const alert = await testEnv.FORECAST_DB.prepare(
      "SELECT COUNT(*) AS count FROM forecast_ops_alerts WHERE alert_key = 'github-dispatch:staging'",
    ).first<{ count: number }>();
    expect(alert?.count).toBe(0);
  });

  it("sends manual-review operations alerts to the alert channel", async () => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO source_queue (
         source, item_id, url, title, published_at, official, status,
         attempts, review_generation, error_code, first_seen_at, updated_at
       ) VALUES ('naver-board-48', 'manual-100', ?, '일정 수동 검토', ?, 1,
         'manual_review', 3, 0, 'schedule_ambiguous', ?, ?)`,
    )
      .bind("https://game.naver.com/lounge/nikke/board/detail/manual-100", nowIso, nowIso, nowIso)
      .run();
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO source_manual_reviews (
         review_id, source, item_id, generation, state, created_at, expires_at
       ) VALUES (?, 'naver-board-48', 'manual-100', 0, 'pending', ?, ?)`,
    )
      .bind(`mr-${"a".repeat(32)}`, nowIso, new Date(now + 7 * 24 * 60 * 60 * 1_000).toISOString())
      .run();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/channels/333333333333333333/messages")) {
        return Response.json({ id: "987654321098765434" }, { status: 200 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeEnv = {
      ...testEnv,
      DISCORD_ACTIVITY_CHANNEL_ID: "222222222222222222",
      DISCORD_ALERT_CHANNEL_ID: "333333333333333333",
      DISCORD_FALLBACK_CHANNEL_ID: "123456789012345678",
      DISPATCH_ENABLED: "true",
    } satisfies DispatcherEnv;

    const result = await runDispatcher(runtimeEnv, { scheduledTime: now });

    expect(result).toMatchObject({ status: "completed", actionableCount: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const alert = await testEnv.FORECAST_DB.prepare(
      `SELECT state, last_sent_occurrence_count, discord_message_id
       FROM forecast_ops_alerts WHERE alert_key = 'manual-review:staging:naver-board-48:manual-100'`,
    ).first<{
      state: string;
      last_sent_occurrence_count: number;
      discord_message_id: string;
    }>();
    expect(alert).toEqual({
      state: "open",
      last_sent_occurrence_count: 1,
      discord_message_id: "987654321098765434",
    });
  });
});

async function generatePrivateKeyPem() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}
