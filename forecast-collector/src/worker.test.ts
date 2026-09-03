import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import schemaSql from "../schema.sql?raw";
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
  } = {},
) {
  const runtimeEnv = { ...testEnv, ...bindings, ENVIRONMENT: "staging" } as CollectorEnv;
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
