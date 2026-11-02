import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schemaSql from "../../test-schema";
import { seedNormalUsageGuard } from "../../test-usage-guard";
import type { CollectorEnv } from "../../types";
import worker from "../../worker";
import { metadataUrl } from "./client";
import { collectorTestEnv } from "./test-support/env";
import { count } from "./test-support/v2-db";

// Disabled modes must not fall back to legacy collection.
const base = collectorTestEnv;
const scheduledTime = Date.parse("2026-10-18T03:00:00.000Z"); // an A slot for v2
const v2Tables = [
  "forecast_v2_monitor_runs",
  "forecast_v2_fetch_attempts",
  "forecast_v2_search_hits",
  "forecast_v2_post_versions",
  "forecast_v2_request_budgets",
  "forecast_v2_legacy_links",
  "forecast_v2_notification_outbox",
];

async function scheduled(mode: string | undefined, skip?: "collection_disabled" | "usage_guard") {
  await reset();
  await executeTestSql(base.FORECAST_DB, schemaSql, applyD1Migrations);
  await seedNormalUsageGuard(base.USAGE_GUARD_DB, scheduledTime);
  if (skip === "usage_guard")
    await base.USAGE_GUARD_DB?.prepare("UPDATE usage_guard_state SET action = 'hard_stop'").run();
  const urls: string[] = [];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return Response.json({ code: 200, content: { feeds: [] } });
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const context = createExecutionContext();
  await worker.scheduled(
    { scheduledTime, cron: "*/3 * * * *", noRetry: vi.fn() },
    {
      ...base,
      ENVIRONMENT: "staging",
      COLLECT_ENABLED: skip === "collection_disabled" ? "false" : "true",
      FORECAST_V2_BOOTSTRAP_CUTOFF: "2026-10-15T00:00:00.000Z",
      ...(mode === undefined ? {} : { FORECAST_V2_MODE: mode }),
    } as CollectorEnv,
    context,
  );
  await waitOnExecutionContext(context);
  const events = log.mock.calls.map(([line]) => {
    try {
      return JSON.parse(String(line)) as { event?: string };
    } catch {
      return String(line);
    }
  });
  const invocations = (
    await base.FORECAST_DB.prepare(
      "SELECT status,poll_mode FROM collector_invocations ORDER BY scheduled_at,invocation_id",
    ).all()
  ).results;
  const v2 = Object.fromEntries(
    await Promise.all(v2Tables.map(async (table) => [table, await count(base.FORECAST_DB, table)])),
  );
  const leases = (
    await base.FORECAST_DB.prepare(
      "SELECT COUNT(*) AS n FROM forecast_v2_monitor_state WHERE lease_owner IS NOT NULL OR consecutive_holds>0",
    ).first<{ n: number }>()
  )?.n;
  fetcher.mockRestore();
  vi.restoreAllMocks();
  return { urls, events, invocations, v2, leases };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: scheduledTime }));

it.each(["collection_disabled", "usage_guard"] as const)("logs skipped %s runs", async (reason) => {
  const result = await scheduled("hold", reason);
  expect(result.events[0]).toMatchObject({
    event: "forecast_v2_scheduled_invocation",
    mode: "hold",
    admission: "skipped",
    reason,
  });
  expect(result.urls).toEqual([]);
  expect(Object.values(result.v2).every((n) => n === 0)).toBe(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("off and unknown modes perform no collection or durable writes", async () => {
  const absent = await scheduled(undefined);
  expect(absent.urls).toEqual([]);
  expect(absent.invocations).toEqual([]);
  expect(absent.events[0]).toMatchObject({
    event: "forecast_v2_scheduled_invocation",
    mode: "off",
    admission: "skipped",
    reason: "v2_off",
  });
  expect(Object.values(absent.v2).every((n) => n === 0)).toBe(true);
  expect(absent.leases).toBe(0);
  for (const mode of ["off", "OFF", "enabled", ""])
    expect(await scheduled(mode), mode).toEqual(absent);
}, 20_000);

it("hold runs only the v2 unit: no legacy collection, no rules or notification writes", async () => {
  const held = await scheduled("hold");
  expect(held.events[0]).toMatchObject({
    event: "forecast_v2_scheduled_invocation",
    mode: "hold",
    admission: "admitted",
  });
  expect(held.invocations).toEqual([]);
  expect(held.urls).toEqual([metadataUrl("A", 0).href]);
  expect(held.v2).toMatchObject({
    forecast_v2_monitor_runs: 1,
    forecast_v2_fetch_attempts: 1,
    forecast_v2_legacy_links: 0,
    forecast_v2_notification_outbox: 0,
  });
});
