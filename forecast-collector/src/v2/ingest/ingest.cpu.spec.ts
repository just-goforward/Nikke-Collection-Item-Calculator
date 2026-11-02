import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { runtimeTestDb } from "../../test-runtime-db";
import { seedNormalUsageGuard } from "../../test-usage-guard";
import type { CollectorEnv } from "../../types";
import { fetchDetail, parseMetadata } from "./client";
import type { RulesPort } from "./rules-port";
import { runV2Invocation, type V2Env } from "./run";
import { detailPath, fixture } from "./test-support/fixtures";
import { FakeNaver, iso, pagePayload, searchTime } from "./test-support/naver";
import { seedVersion } from "./test-support/v2-db";

// T15 Node proxy: process.threadCpuUsage (user+system) per single ingest unit,
// worst-case input, local SQLite through the D1 adapter, real usage guard,
// mocked GET. Limit 50 ms (workerd ≤ 100 ms is S6). Run this file alone.
const LIMIT_MS = 50;
const results: Record<string, number> = {};
let sqlite: DatabaseSync;
let db: D1Database;
let naver: FakeNaver;
const schema = readFileSync(
  new URL("../../../fixtures/schema-v27-test.sql", import.meta.url),
  "utf8",
);
const cutoff = "2024-10-01T00:00:00.000Z";
const rules: RulesPort = {
  applyPendingDecisions: async () => ({ applied: 0 }),
  processPostVersion: async () => ({ calendarDirty: false, decisionRequests: 0, grants: 0 }),
  rebuildCalendar: async () => ({ snapshotId: null, changed: false }),
  dueEFollowUps: async () => 0,
};

async function invoke(instant: string) {
  const now = Date.parse(instant);
  vi.setSystemTime(now);
  const env = {
    FORECAST_DB: db,
    USAGE_GUARD_DB: db,
    ADMIN_TOKEN: "local",
    ENVIRONMENT: "staging",
    DEPLOY_SHA: "local",
    POLL_MODE: "both",
    FORECAST_V2_MODE: "on",
    FORECAST_V2_BOOTSTRAP_CUTOFF: cutoff,
  } satisfies CollectorEnv as V2Env;
  const start = process.threadCpuUsage();
  const result = await runV2Invocation(env, now, { fetcher: naver.fetcher, rules });
  const used = process.threadCpuUsage(start);
  return { result, ms: (used.user + used.system) / 1000 };
}
function record(name: string, ms: number) {
  results[name] = Math.round(ms * 100) / 100;
  expect(ms, name).toBeLessThanOrEqual(LIMIT_MS);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-18T03:00:00.000Z") });
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  db = runtimeTestDb(sqlite);
  await seedNormalUsageGuard(db, Date.parse("2026-10-18T03:00:00.000Z"));
  naver = new FakeNaver();
});
afterEach(() => {
  vi.useRealTimers();
  sqlite.close();
});
afterAll(() => {
  console.log(
    JSON.stringify({
      t15: "forecast-v2-ingest",
      node: process.version,
      limitMs: LIMIT_MS,
      cpuMs: results,
      method:
        "process.threadCpuUsage user+system per runV2Invocation; node:sqlite D1 adapter; mocked fetch",
    }),
  );
});

it("search metadata unit up to the 4-page cap (captured D rows, 30/page, 90 stored hits reloaded)", async () => {
  const source = (await fixture("search-D-0.json")).content.feeds ?? [];
  const rows = Array.from({ length: 120 }, (_, i) => {
    const kst = new Date(Date.parse("2026-10-18T11:00:00+09:00") - i * 60_000 + 9 * 3_600_000)
      .toISOString()
      .slice(0, 19);
    return {
      ...source[i % source.length],
      feedId: 9_000_000 - i,
      createdDate: searchTime(kst),
      updatedDate: searchTime(kst),
    };
  });
  for (const row of rows)
    await seedVersion(
      db,
      String(row.feedId),
      iso(row.createdDate.slice(0, 19)),
      iso(row.createdDate.slice(0, 19)),
      56,
    );
  for (let p = 0; p < 4; p++) naver.page("D", p, pagePayload(rows.slice(p * 30, p * 30 + 30)));
  const pages = [];
  // 04:09 continues the D run (:39/:42/:48 are rules slots); usage telemetry is
  // refreshed first so the guard admits the later hour.
  for (const minute of ["03:24", "03:27", "03:30", "04:09"]) {
    const now = `2026-10-18T${minute}:00.000Z`;
    if (minute === "04:09") await seedNormalUsageGuard(db, Date.parse(now));
    pages.push(await invoke(now));
  }
  expect(pages.map((page) => page.result.outcome)).toEqual([
    "running",
    "running",
    "running",
    "held",
  ]);
  for (const [index, page] of pages.entries())
    record(`search_page_${index}${index === 3 ? "_cap_hold" : ""}`, page.ms);
});

it("G list unit (captured 10-row page)", async () => {
  naver.page("G", 0, await fixture("board48-limit10-6.json"));
  const { result, ms } = await invoke("2026-10-18T03:03:00.000Z");
  expect(result.outcome).toBe("running");
  record("g_list_page", ms);
});

it("detail unit with the largest captured body (6848849, 248,529 bytes)", async () => {
  const list = await fixture("board48-limit10-6.json");
  const row = (list.content.feeds ?? []).find((feed) => feed["feedId"] === 6848849);
  naver.page("G", 0, pagePayload([row])).detail(6848849, await fixture(detailPath(6848849)));
  expect((await invoke("2026-10-18T03:03:00.000Z")).result.outcome).toBe("completed");
  const { result, ms } = await invoke("2026-10-18T03:09:00.000Z");
  expect(result.outcome).toBe("body_stored");
  record("detail_largest_body", ms);
  const { result: dispatched, ms: rulesMs } = await invoke("2026-10-18T03:39:00.000Z");
  expect(dispatched.outcome).toBe("rules_processed");
  record("rules_dispatch_stub_port", rulesMs);
});

it("pure client parsing of the worst-case inputs", async () => {
  const page = pagePayload(((await fixture("search-D-0.json")).content.feeds ?? []).slice(0, 30));
  const detail = await fixture(detailPath(6848849));
  const list = parseMetadata(await fixture("board48-limit10-6.json"), "G");
  const expected = list.find((entry) => entry.feedId === "6848849")!;
  const start = process.threadCpuUsage();
  parseMetadata(page, "D");
  await fetchDetail("G", expected, async () => Response.json(detail));
  const used = process.threadCpuUsage(start);
  record("client_parse_page_and_largest_detail", (used.user + used.system) / 1000);
});
