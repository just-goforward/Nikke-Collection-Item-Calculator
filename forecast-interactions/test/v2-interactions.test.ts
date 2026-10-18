import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedNormalUsageGuard } from "../../forecast-collector/src/test-usage-guard.ts";
import { executeTestSql } from "../../shared/testD1Sql.ts";
import type { InteractionRouterEnv } from "../src/types.ts";
import { handleV2Interaction, kstInput } from "../src/v2-interactions.ts";
import { seedV2Decision, v2Baseline, v2Migrations } from "./v2-test-fixture.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
let testEnv: InteractionRouterEnv;
let db: D1Database;
function assertRouterBindings(value: object): asserts value is InteractionRouterEnv {
  for (const key of ["STAGING_FORECAST_DB", "USAGE_GUARD_DB"]) {
    const binding = Reflect.get(value, key);
    if (!binding || typeof binding.prepare !== "function" || typeof binding.batch !== "function")
      throw new Error(`missing_test_binding:${key}`);
  }
  for (const key of [
    "DISCORD_PUBLIC_KEY",
    "DISCORD_APPLICATION_ID",
    "DISCORD_GUILD_ID",
    "DISCORD_FORECAST_APPROVER_USER_ID",
    "DISCORD_APPROVAL_CHANNEL_ID",
    "DISCORD_ALERT_CHANNEL_ID",
    "DISCORD_ACTIVITY_CHANNEL_ID",
    "FORECAST_PUBLICATION_KEY_ID",
    "DEPLOY_SHA",
    "PRODUCTION_MUTATIONS_ENABLED",
  ]) {
    if (typeof Reflect.get(value, key) !== "string") throw new Error(`missing_test_var:${key}`);
  }
  for (const key of ["STAGING_PUBLICATION_MODE", "PRODUCTION_PUBLICATION_MODE"]) {
    if (!["off", "enabled"].includes(Reflect.get(value, key)))
      throw new Error(`invalid_test_mode:${key}`);
  }
}
beforeEach(async () => {
  await reset();
  assertRouterBindings(env);
  testEnv = {
    ...env,
    FORECAST_ENVIRONMENT: "staging",
    STAGING_PUBLICATION_MODE: "enabled",
    PRODUCTION_PUBLICATION_MODE: "off",
  };
  Object.defineProperty(testEnv, "PRODUCTION_FORECAST_DB", {
    get() {
      throw new Error("production");
    },
  });
  db = testEnv.STAGING_FORECAST_DB;
  for (const sql of [v2Baseline, ...v2Migrations]) await executeTestSql(db, sql, applyD1Migrations);
  await seedNormalUsageGuard(testEnv.USAGE_GUARD_DB);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({})),
  );
});
async function seed(type = "solo_review") {
  await seedV2Decision(db, testEnv.DISCORD_APPROVAL_CHANNEL_ID, type);
}
it.each(["bok", "bedit"])(
  "fences %s against a source edit immediately before commit",
  async (action) => {
    await seed();
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      // Same content hash deliberately: version identity, not content alone, must fence.
      await db
        .prepare(`INSERT INTO forecast_v2_post_versions
      (version_id,feed_id,updated_date,content_hash,board_id,created_at,fetched_at,body_text)
      VALUES('new-source','1','2026-01-02',?,11,'2026-01-01','2026-01-02','original')`)
        .bind("a".repeat(64))
        .run();
      return batch(statements);
    });
    expect(await click(`fv2:s:${action}:d:0`)).toMatchObject({
      type: 4,
      data: { content: "공지가 수정되어 이 결정은 더 이상 유효하지 않습니다", flags: 64 },
    });
    expect(
      await db.prepare("SELECT COUNT(*) n FROM forecast_v2_consumed_interactions").first(),
    ).toEqual({ n: 0 });
    expect(await db.prepare("SELECT COUNT(*) n FROM forecast_v2_decision_results").first()).toEqual(
      { n: 0 },
    );
    expect(await db.prepare("SELECT status FROM forecast_v2_decision_requests").first()).toEqual({
      status: "pending",
    });
  },
);
async function click(customId: string, overrides: object = {}) {
  const context = createExecutionContext();
  const response = await handleV2Interaction(
    {
      id: "1001",
      token: "fixture-token",
      application_id: testEnv.DISCORD_APPLICATION_ID,
      type: 3,
      guild_id: testEnv.DISCORD_GUILD_ID,
      channel_id: testEnv.DISCORD_APPROVAL_CHANNEL_ID,
      member: { user: { id: testEnv.DISCORD_FORECAST_APPROVER_USER_ID } },
      message: { id: "666666666" },
      data: { custom_id: customId, component_type: 2 },
      ...overrides,
    },
    testEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return (await response.json()) as { type: number };
}
it.each(["bok", "bno", "opt"])("records %s once and rejects replay", async (action) => {
  await seed(action === "opt" ? "grant_date" : "solo_review");
  const id = `fv2:s:${action}:d:0${action === "opt" ? ":a" : ""}`;
  expect(await click(id)).toMatchObject({
    type: 7,
    data: {
      content: expect.stringContaining("기록"),
      components: [],
      allowed_mentions: { parse: [] },
    },
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(await click(id)).toMatchObject({
    type: 4,
    data: { content: expect.stringContaining("만료") },
  });
  expect(await db.prepare("SELECT status FROM forecast_v2_decision_requests").first()).toEqual({
    status: "resolved",
  });
  expect(await db.prepare("SELECT COUNT(*) n FROM forecast_v2_decision_results").first()).toEqual({
    n: 1,
  });
});
it.each(["fv2:p:bok:d:0", "fv2:s:bad:d:0", "fv2:s:bok:d:1"])("rejects %s", async (id) => {
  await seed();
  expect(await click(id)).toMatchObject({ data: { content: expect.stringContaining("만료") } });
  expect(
    await db.prepare("SELECT COUNT(*) n FROM forecast_v2_consumed_interactions").first(),
  ).toEqual({ n: 0 });
});
it.each(["solo_review", "collaboration", "maintenance"])(
  "opens and records %s KST edits",
  async (type) => {
    await seed(type);
    expect(await click("fv2:s:bedit:d:0")).toMatchObject({
      type: 9,
      data: {
        custom_id: "fv2m:s:d:0",
        components: [
          { component: { value: "2026-11-01 12:00" } },
          { component: { value: "2026-11-02 05:00" } },
        ],
      },
    });
    expect(
      await click("fv2m:s:d:0", {
        id: "1002",
        type: 5,
        data: {
          custom_id: "fv2m:s:d:0",
          components: [
            { component: { custom_id: "start", value: "2026-11-03 12:00" } },
            { component: { custom_id: "end", value: "2026-11-04 05:00" } },
          ],
        },
      }),
    ).toMatchObject({ type: 6 });
    const row = await db
      .prepare("SELECT result_json FROM forecast_v2_decision_results")
      .first<{ result_json: string }>();
    expect(JSON.parse(row?.result_json ?? "{}")).toMatchObject({
      action: "edit",
      startAt: "2026-11-03T12:00:00+09:00",
      endAt: "2026-11-04T05:00:00+09:00",
    });
    expect(fetch).toHaveBeenCalledWith(
      `https://discord.com/api/v10/webhooks/${testEnv.DISCORD_APPLICATION_ID}/fixture-token/messages/@original`,
      expect.objectContaining({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: expect.stringContaining("일정 수정"),
      }),
    );
  },
);
it.each(["false", "missing"])("rejects bok with %s completeness", async (complete) => {
  await seedV2Decision(db, testEnv.DISCORD_APPROVAL_CHANNEL_ID, "solo_review", "d", null, 0, false);
  if (complete === "missing") {
    const row = await db
      .prepare("SELECT payload_json FROM forecast_v2_decision_requests")
      .first<{ payload_json: string }>();
    const payload = JSON.parse(row?.payload_json ?? "{}");
    delete payload.extracted.complete;
    const json = JSON.stringify(payload);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
    const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
    await db
      .prepare("UPDATE forecast_v2_decision_requests SET payload_json=?,payload_hash=?")
      .bind(json, hex)
      .run();
  }
  expect(await click("fv2:s:bok:d:0")).toMatchObject({ type: 4 });
  expect(
    await db.prepare("SELECT COUNT(*) n FROM forecast_v2_consumed_interactions").first(),
  ).toEqual({ n: 0 });
  expect(await db.prepare("SELECT COUNT(*) n FROM forecast_v2_decision_results").first()).toEqual({
    n: 0,
  });
});
it.each(["expired", "resolved", "stale"])("rejects %s requests without writes", async (status) => {
  await seed();
  await db.prepare("UPDATE forecast_v2_decision_requests SET status=?").bind(status).run();
  for (const id of ["fv2:s:bok:d:0", "fv2:s:bedit:d:0", "fv2:s:bno:d:0", "fv2m:s:d:0"]) {
    expect(await click(id, id.startsWith("fv2m:") ? { type: 5 } : {})).toMatchObject({
      type: 4,
      data: { content: expect.stringContaining("대기 중이 아닌") },
    });
  }
  expect(
    await db.prepare("SELECT COUNT(*) n FROM forecast_v2_consumed_interactions").first(),
  ).toEqual({ n: 0 });
});
it.each(["2026-02-30 12:00", "2026-01-01 24:00", "2026-01-01T12:00"])(
  "rejects invalid KST %s",
  (value) => {
    expect(() => kstInput(value)).toThrow();
  },
);
it.each([{ guild_id: "wrong" }, { channel_id: "wrong" }, { member: { user: { id: "wrong" } } }])(
  "rejects unauthorized context %j",
  async (overrides) => {
    await seed();
    expect(await click("fv2:s:bok:d:0", overrides)).toMatchObject({ type: 4 });
    expect(
      await db.prepare("SELECT COUNT(*) n FROM forecast_v2_consumed_interactions").first(),
    ).toEqual({ n: 0 });
  },
);
it.each(["expired", "resolved", "worker-environment", "cas"])(
  "rejects %s without consuming",
  async (condition) => {
    if (condition === "cas") {
      await seedV2Decision(db, testEnv.DISCORD_APPROVAL_CHANNEL_ID, "solo_review", "d", "event", 0);
      await db
        .prepare(`INSERT INTO forecast_v2_calendar_revisions(event_id,revision,kind,status,source_feed_ids_json,created_at)
      VALUES('event',1,'solo','confirmed','[]','now')`)
        .run();
      await db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES('event',1)").run();
    } else {
      await seed();
      if (condition === "expired")
        await db.prepare("UPDATE forecast_v2_decision_requests SET expires_at='2000-01-01'").run();
      if (condition === "resolved")
        await db.prepare("UPDATE forecast_v2_decision_requests SET status='resolved'").run();
      if (condition === "worker-environment") testEnv.FORECAST_ENVIRONMENT = "production";
    }
    expect(await click("fv2:s:bok:d:0")).toMatchObject({ type: 4 });
    expect(
      await db.prepare("SELECT COUNT(*) n FROM forecast_v2_consumed_interactions").first(),
    ).toEqual({ n: 0 });
  },
);
it("atomically chooses one concurrent click", async () => {
  await seed();
  const responses = await Promise.all([
    click("fv2:s:bok:d:0"),
    click("fv2:s:bno:d:0", { id: "1002" }),
  ]);
  expect(responses.map((r) => r.type).sort()).toEqual([4, 7]);
  expect(
    await db.prepare("SELECT COUNT(*) n FROM forecast_v2_consumed_interactions").first(),
  ).toEqual({ n: 1 });
});
it("rejects replay of a consumed modal-opening ID while request remains pending", async () => {
  await seed();
  expect(await click("fv2:s:bedit:d:0")).toMatchObject({ type: 9 });
  expect(await click("fv2:s:bok:d:0")).toMatchObject({ type: 4 });
  expect(await db.prepare("SELECT COUNT(*) n FROM forecast_v2_decision_results").first()).toEqual({
    n: 0,
  });
});
it.each(["", "bad", "2026-11-03 12:00", "2026-11-02 12:00"])(
  "rejects maintenance modal end %s",
  async (end) => {
    await seed("maintenance");
    expect(
      await click("fv2m:s:d:0", {
        type: 5,
        data: {
          custom_id: "fv2m:s:d:0",
          components: [
            { component: { custom_id: "start", value: "2026-11-03 12:00" } },
            { component: { custom_id: "end", value: end } },
          ],
        },
      }),
    ).toMatchObject({ type: 4 });
    expect(
      await db.prepare("SELECT COUNT(*) n FROM forecast_v2_consumed_interactions").first(),
    ).toEqual({ n: 0 });
  },
);
