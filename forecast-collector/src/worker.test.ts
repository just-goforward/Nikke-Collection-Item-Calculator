import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import schemaSql from "../schema.sql?raw";
import { pollNaverSource } from "./source-queue";
import { seedNormalUsageGuard } from "./test-usage-guard";
import type { CollectorEnv } from "./types";
import worker from "./worker";

const testEnv = env as unknown as CollectorEnv;

beforeEach(async () => {
  await reset();
  for (const statement of schemaSql
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    await testEnv.FORECAST_DB.prepare(statement).run();
  }
  await seedNormalUsageGuard(testEnv.USAGE_GUARD_DB);
});

describe("forecast collector runtime switch", () => {
  it("does not touch D1 when scheduled collection is disabled", async () => {
    const waitUntil = vi.fn();

    await worker.scheduled(
      { scheduledTime: Date.now() } as ScheduledController,
      { ...testEnv, COLLECT_ENABLED: "false" },
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(waitUntil).not.toHaveBeenCalled();
    const count = await testEnv.FORECAST_DB.prepare(
      "SELECT COUNT(*) AS count FROM collector_invocations",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });
});

describe("forecast collector route dispatch boundary", () => {
  it.each([
    ["/admin/probe", "probe"],
    ["/admin/dispatcher-smoke", "dispatcher-smoke"],
    [`/admin/workflow-dispatches/fd-${"a".repeat(32)}/status`, "workflow-dispatches"],
    ["/admin/ops-alerts/watchdog-fallback", "ops-alerts"],
    ["/admin/source-queue/process", "source-queue"],
    [`/admin/manual-reviews/mr-${"a".repeat(32)}/decision`, "manual-reviews"],
    ["/admin/canary-deployments/start", "canary-deployments"],
    ["/admin/discord-test-approvals", "discord"],
  ])("applies the shared authenticated limit before dispatching %s", async (path, group) => {
    const limit = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });
    const response = await invokeAdmin(
      { ADMIN_RATE_LIMITER: { limit } as unknown as RateLimit, ADMIN_TOKEN: "expected-token" },
      { token: "expected-token", path, method: "POST", body: "invalid-json" },
    );
    expect(response.status).toBe(429);
    expect(limit.mock.calls).toEqual([
      [{ key: "admin-unauth:unknown" }],
      [{ key: `admin-auth:POST:${group}` }],
    ]);
  });

  it.each([
    ["GET", "/admin/probe"],
    ["DELETE", "/admin/candidates"],
    ["POST", "/admin/unknown"],
  ])("retains 404 for unsupported %s %s", async (method, path) => {
    const response = await invokeAdmin(
      {
        ADMIN_RATE_LIMITER: {
          limit: vi.fn().mockResolvedValue({ success: true }),
        } as unknown as RateLimit,
        ADMIN_TOKEN: "expected-token",
      },
      { token: "expected-token", path, method },
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it.each([
    "/admin/dispatcher-smoke",
    "/admin/discord-test-approvals",
    "/admin/discord-staging-adoptions",
    `/admin/discord-staging-adoptions/discord-staging-${"a".repeat(36)}/message`,
    `/admin/discord-staging-adoptions/discord-staging-${"a".repeat(36)}/adoption-pr`,
  ])("keeps staging-only route %s unavailable in production", async (path) => {
    const response = await invokeAdmin(
      {
        ADMIN_RATE_LIMITER: {
          limit: vi.fn().mockResolvedValue({ success: true }),
        } as unknown as RateLimit,
        ADMIN_TOKEN: "expected-token",
      },
      { token: "expected-token", path, method: "POST", body: "{}", environment: "production" },
    );
    expect(response.status).toBe(404);
  });
});

describe("forecast collector boundary recovery", () => {
  it("keeps boundary recovery behind production admin authentication and rate limiting", async () => {
    const responseFor = (ids: readonly number[]) =>
      Response.json({
        code: 200,
        content: {
          feeds: ids.map((feedId) => ({
            feed: {
              feedId,
              loungeId: "nikke",
              title: `공지 ${feedId}`,
              createdDate: "20260824120000",
            },
            user: { userRoleCode: "game_manager" },
            board: { boardId: 48 },
          })),
        },
      });
    await pollNaverSource(
      testEnv.FORECAST_DB,
      48,
      vi.fn<typeof fetch>().mockResolvedValue(responseFor([100])),
      "production",
    );
    await expect(
      pollNaverSource(
        testEnv.FORECAST_DB,
        48,
        vi.fn<typeof fetch>().mockResolvedValue(responseFor([110])),
        "production",
      ),
    ).rejects.toThrow("naver_scan_boundary_missing");
    const options = {
      path: "/admin/source-queue/process",
      method: "POST",
      environment: "production" as const,
      body: JSON.stringify({
        mode: "recover-boundary",
        environment: "production",
        source: "naver-board-48",
        expectedCommittedItemId: "100",
      }),
    };
    const limit = vi.fn().mockResolvedValue({ success: true });
    const bindings = {
      ADMIN_RATE_LIMITER: { limit } as unknown as RateLimit,
      ADMIN_TOKEN: "expected-token",
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => responseFor([141, 100]));
    vi.stubGlobal("fetch", fetcher);
    try {
      expect((await invokeAdmin(bindings, options)).status).toBe(401);
      limit.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
      expect((await invokeAdmin(bindings, { ...options, token: "expected-token" })).status).toBe(
        429,
      );
      expect(fetcher).not.toHaveBeenCalled();
      limit.mockClear();
      const response = await invokeAdmin(bindings, { ...options, token: "expected-token" });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        recovered: true,
        source: "naver-board-48",
        queuedItems: 1,
      });
      expect(limit.mock.calls).toEqual([
        [{ key: "admin-unauth:unknown" }],
        [{ key: "admin-auth:POST:source-queue" }],
      ]);
      const state = await testEnv.FORECAST_DB.prepare(
        "SELECT committed_item_id, next_offset FROM source_poll_state WHERE source = 'naver-board-48'",
      ).first();
      expect(state).toEqual({ committed_item_id: "141", next_offset: 0 });
      const hold = await testEnv.FORECAST_DB.prepare(
        "SELECT state FROM forecast_ops_alerts WHERE alert_key = 'naver-boundary:production:48'",
      ).first();
      expect(hold).toEqual({ state: "resolved" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("forecast collector admin boundary", () => {
  it("checks the admin rate limiter before bearer authentication", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const response = await invokeAdmin({
      ADMIN_RATE_LIMITER: { limit } as unknown as RateLimit,
      ADMIN_TOKEN: "expected-token",
    });

    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "admin-unauth:unknown" });
  });

  it("rejects an invalid bearer after an allowed rate-limit check", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const response = await invokeAdmin({
      ADMIN_RATE_LIMITER: { limit } as unknown as RateLimit,
      ADMIN_TOKEN: "expected-token",
    });

    expect(response.status).toBe(401);
    expect(limit).toHaveBeenCalledOnce();
  });

  it("keeps unauthenticated IP abuse separate from an authenticated route budget", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const binding = { limit } as unknown as RateLimit;

    for (let index = 0; index < 60; index += 1) {
      const response = await invokeAdmin(
        { ADMIN_RATE_LIMITER: binding, ADMIN_TOKEN: "expected-token" },
        { sourceAddress: "203.0.113.10", token: "wrong-token" },
      );
      expect(response.status).toBe(401);
    }
    const authorized = await invokeAdmin(
      { ADMIN_RATE_LIMITER: binding, ADMIN_TOKEN: "expected-token" },
      { sourceAddress: "203.0.113.11", token: "expected-token" },
    );

    expect(authorized.status).toBe(200);
    expect(limit).toHaveBeenLastCalledWith({ key: "admin-auth:GET:candidates" });
    const keys = limit.mock.calls.map(([input]) => (input as { key: string }).key);
    expect(keys.filter((key) => key === "admin-unauth:203.0.113.10")).toHaveLength(60);
    expect(keys).toContain("admin-unauth:203.0.113.11");
  });

  it("serves a lightweight canary window without requiring a full report", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const response = await invokeAdmin(
      {
        ADMIN_RATE_LIMITER: { limit } as unknown as RateLimit,
        ADMIN_TOKEN: "expected-token",
      },
      { token: "expected-token", path: "/admin/canary-window" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: 10,
      policyId: "forecast-canary-v10-live-contract-v1",
      canaryId: null,
      pollMode: "missing",
      acceptance: { windowMode: "fixed_8_hours", windowHours: null },
      window: { active: false, eligible: false },
    });
    expect(limit).toHaveBeenLastCalledWith({ key: "admin-auth:GET:canary-window" });
  });

  it("accepts a null final quota as incomplete evidence instead of rejecting the report request", async () => {
    const response = await invokeAdmin(
      {
        ADMIN_RATE_LIMITER: {
          limit: vi.fn().mockResolvedValue({ success: true }),
        } as unknown as RateLimit,
        ADMIN_TOKEN: "expected-token",
      },
      {
        token: "expected-token",
        path: "/admin/canary-report",
        method: "POST",
        body: JSON.stringify({
          canaryId: `fc-${"a".repeat(32)}`,
          quotaEvidence: null,
          runtimeTelemetry: null,
          runtimeBaseline: null,
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      evidence: { status: "incomplete" },
      certification: { status: "incomplete", hardFailures: [] },
    });
  });

  it("persists an unexpected source processor failure as a critical operations alert", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const response = await invokeAdmin(
      {
        ADMIN_RATE_LIMITER: { limit } as unknown as RateLimit,
        ADMIN_TOKEN: "expected-token",
      },
      {
        token: "expected-token",
        path: "/admin/ops-alerts/source-processor-internal",
        method: "POST",
        body: JSON.stringify({
          runId: 123456,
          runUrl:
            "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/123456",
        }),
      },
    );

    expect(response.status).toBe(200);
    const alert = await testEnv.FORECAST_DB.prepare(
      `SELECT severity, component, error_code FROM forecast_ops_alerts
       WHERE alert_key = 'source-processor-internal:staging:123456'`,
    ).first<{ severity: string; component: string; error_code: string }>();
    expect(alert).toEqual({
      severity: "critical",
      component: "source-processor",
      error_code: "source_processor_internal",
    });
  });
});

async function invokeAdmin(
  bindings: Pick<CollectorEnv, "ADMIN_RATE_LIMITER" | "ADMIN_TOKEN">,
  options: {
    sourceAddress?: string;
    token?: string;
    path?: string;
    method?: string;
    body?: string;
    environment?: "staging" | "production";
  } = {},
) {
  const runtimeEnv = {
    ...testEnv,
    ...bindings,
    ENVIRONMENT: options.environment ?? "staging",
    DISCORD_APPROVAL_MODE: "staging_adoption",
  } as CollectorEnv;
  const context = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;
  const init: RequestInit = {
    headers: {
      authorization: `Bearer ${options.token ?? "wrong-token"}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.sourceAddress ? { "cf-connecting-ip": options.sourceAddress } : {}),
    },
    ...(options.method === undefined ? {} : { method: options.method }),
    ...(options.body === undefined ? {} : { body: options.body }),
  };
  return worker.fetch(
    new Request(
      `https://collector.example${options.path ?? "/admin/candidates"}`,
      init,
    ) as unknown as Parameters<typeof worker.fetch>[0],
    runtimeEnv,
    context,
  );
}
