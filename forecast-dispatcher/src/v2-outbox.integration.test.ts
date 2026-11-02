import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import historicalCore from "../../scripts/fixtures/forecast-preservation-historical-core.sql?raw";
import { executeTestSql } from "../../shared/testD1Sql.ts";
import { sha256Hex } from "./crypto.ts";
import type { DispatcherEnv } from "./types.ts";
import { drainV2Outbox } from "./v2-outbox.ts";

const migrations = new Map<number, string>(
  Object.entries(import.meta.glob<string>("../../forecast-collector/migrations/*.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  })).map(([name, sql]) => [Number(name.split("/").pop()!.slice(0, 4)), sql]),
);
const testEnv = { ...env, FORECAST_V2_NOTIFICATIONS_ENABLED: "true" } as DispatcherEnv;
const db = testEnv.FORECAST_DB;
const now = Date.parse("2026-10-18T00:00:00Z");
const messageId = "123456789012345678";

beforeEach(async () => {
  await reset();
  vi.setSystemTime(now);
  // Match fixtureDDL's historical v10 route: 0027 requires its positional layout,
  // not the amended bootstrap. Stage 0005 for 0012; 0004/0006 are staging-only.
  await executeTestSql(db, historicalCore, applyD1Migrations);
  for (const version of [3, 7, 8, 9, 10, 5, ...Array.from({ length: 24 }, (_, i) => i + 11)]) {
    await executeTestSql(db, migrations.get(version)!, applyD1Migrations);
  }
  expect(
    (await db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).results,
  ).toEqual([1, 2, 3, 5, ...Array.from({ length: 28 }, (_, i) => i + 7)]
    .map((version) => ({ version })));
  const payload = JSON.stringify({ decisionRequestId: "one" });
  const hash = await sha256Hex(payload);
  await db
    .prepare(`INSERT INTO forecast_v2_decision_requests
    (decision_id,type,payload_json,payload_hash,expected_calendar_revision,expires_at,status,created_at)
    VALUES('one','solo_review',?,?,7,'2026-11-01T00:00:00Z','pending','2026-10-18T00:00:00Z')`)
    .bind(payload, hash)
    .run();
  await db
    .prepare(`INSERT INTO forecast_v2_notification_outbox
    (outbox_id,idempotency_key,kind,decision_id,channel_role,payload_json,payload_hash,next_attempt_at,created_at,updated_at)
    VALUES('one','key','decision_reminder','one','approval',?,?,?,'2026-10-18T00:00:00Z','2026-10-18T00:00:00Z')`)
    .bind(payload, hash, now)
    .run();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function assertCommitted(attempts: number) {
  expect(
    await db
      .prepare(`SELECT state,attempts,message_id,channel_id,lease_token,lease_until,error_code
    FROM forecast_v2_notification_outbox WHERE outbox_id='one'`)
      .first(),
  ).toEqual({
    state: "sent",
    attempts,
    message_id: messageId,
    channel_id: testEnv.DISCORD_APPROVAL_CHANNEL_ID,
    lease_token: null,
    lease_until: null,
    error_code: null,
  });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}

it("marks invalid rendering terminal without sending and logs an alert", async () => {
  const payload = JSON.stringify({ decisionRequestId: "invalid:id" });
  await db
    .prepare("UPDATE forecast_v2_notification_outbox SET payload_json=?,payload_hash=?")
    .bind(payload, await sha256Hex(payload))
    .run();
  const outbound = vi.fn();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", outbound);
  try {
    expect(await drainV2Outbox(testEnv)).toBe(0);
    expect(await db.prepare("SELECT state FROM forecast_v2_notification_outbox").first()).toEqual({
      state: "dead",
    });
    expect(await drainV2Outbox(testEnv)).toBe(0);
    expect(outbound).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("v2_notification_invalid"));
  } finally {
    log.mockRestore();
  }
});

it("leases a real D1 row, sends once, commits and never selects the sent row again", async () => {
  const outbound = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.method).toBe("POST");
    expect(
      await db
        .prepare("SELECT state,attempts,lease_until FROM forecast_v2_notification_outbox")
        .first(),
    ).toEqual({ state: "sending", attempts: 1, lease_until: now + 60000 });
    expect(JSON.parse(String(init.body))).toMatchObject({
      allowed_mentions: { parse: [] },
      enforce_nonce: true,
      embeds: [{ footer: { text: "ref:key" } }],
    });
    return Response.json({ id: messageId });
  });
  vi.stubGlobal("fetch", outbound);
  expect(await drainV2Outbox(testEnv)).toBe(1);
  await assertCommitted(1);
  expect(await drainV2Outbox(testEnv)).toBe(0);
  expect(outbound).toHaveBeenCalledTimes(1);
});

it.each([0, 4])("recovers a D1 commit failure after send at prior attempt %s", async (attempts) => {
  await db.prepare("UPDATE forecast_v2_notification_outbox SET attempts=?").bind(attempts).run();
  await db
    .prepare(`CREATE TRIGGER test_fail_sent BEFORE UPDATE ON forecast_v2_notification_outbox
    WHEN NEW.state='sent' BEGIN SELECT RAISE(ABORT,'test_commit_failure'); END`)
    .run();
  let delivered: unknown;
  const outbound = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      delivered = { ...JSON.parse(String(init.body)), id: messageId };
      return Response.json({ id: messageId });
    }
    expect(url).toBe(
      `https://discord.com/api/v10/channels/${testEnv.DISCORD_APPROVAL_CHANNEL_ID}/messages?limit=50`,
    );
    return Response.json(delivered ? [delivered] : []);
  });
  vi.stubGlobal("fetch", outbound);
  expect(await drainV2Outbox(testEnv)).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT state,attempts,next_attempt_at,lease_token FROM forecast_v2_notification_outbox",
      )
      .first(),
  ).toEqual({
    state: "pending",
    attempts: attempts + 1,
    next_attempt_at: now + 60000,
    lease_token: null,
  });
  expect(await drainV2Outbox(testEnv)).toBe(0);
  await db.prepare("DROP TRIGGER test_fail_sent").run();
  vi.setSystemTime(now + 180000);
  expect(await drainV2Outbox(testEnv)).toBe(1);
  await assertCommitted(attempts + 2);
  expect(outbound).toHaveBeenCalledTimes(attempts ? 3 : 2);
  expect(outbound.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
});

it("caps final-send commit recovery at five lookups and raises an ops alert", async () => {
  await db.prepare("UPDATE forecast_v2_notification_outbox SET attempts=4").run();
  await db
    .prepare(`CREATE TRIGGER test_fail_sent BEFORE UPDATE ON forecast_v2_notification_outbox
    WHEN NEW.state='sent' BEGIN SELECT RAISE(ABORT,'test_commit_failure'); END`)
    .run();
  let delivered = false;
  const outbound = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "POST") {
      delivered = true;
      return Response.json({ id: messageId });
    }
    return Response.json(
      delivered ? [{ id: messageId, embeds: [{ footer: { text: "ref:key" } }] }] : [],
    );
  });
  vi.stubGlobal("fetch", outbound);
  for (let attempt = 0; attempt < 6; attempt++) {
    vi.setSystemTime(now + attempt * 60000);
    expect(await drainV2Outbox(testEnv)).toBe(0);
  }
  expect(
    await db
      .prepare("SELECT state,attempts,error_code FROM forecast_v2_notification_outbox")
      .first(),
  ).toEqual({ state: "dead", attempts: 10, error_code: "v2_reconciliation_exhausted" });
  expect(
    await db
      .prepare(
        "SELECT state,error_code FROM forecast_ops_alerts WHERE alert_key='v2-reconciliation:one'",
      )
      .first(),
  ).toEqual({ state: "open", error_code: "v2_reconciliation_exhausted" });
  expect(outbound.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  expect(outbound).toHaveBeenCalledTimes(7);
  vi.setSystemTime(now + 3600000);
  expect(await drainV2Outbox(testEnv)).toBe(0);
  expect(outbound).toHaveBeenCalledTimes(7);
});

it("retries final-lease cleanup fairly without another reconciliation or claim", async () => {
  const leaseUntil = now + 60000;
  await db
    .prepare(`UPDATE forecast_v2_notification_outbox
      SET state='sending',attempts=10,lease_token='interrupted',lease_until=?,channel_id=?
      WHERE outbox_id='one'`)
    .bind(leaseUntil, testEnv.DISCORD_APPROVAL_CHANNEL_ID)
    .run();
  const outbound = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body)).embeds[0].footer.text).toBe("ref:healthy-key");
    return Response.json({ id: messageId });
  });
  vi.stubGlobal("fetch", outbound);
  expect(await drainV2Outbox(testEnv)).toBe(0);
  expect(
    await db
      .prepare("SELECT state,attempts,lease_token,lease_until FROM forecast_v2_notification_outbox")
      .first(),
  ).toEqual({ state: "sending", attempts: 10, lease_token: "interrupted", lease_until: leaseUntil });

  vi.setSystemTime(leaseUntil);
  await db
    .prepare(`INSERT INTO forecast_v2_notification_outbox
      (outbox_id,idempotency_key,kind,decision_id,channel_role,payload_json,payload_hash,next_attempt_at,created_at,updated_at)
      SELECT 'healthy','healthy-key',kind,decision_id,channel_role,payload_json,payload_hash,?,created_at,updated_at
      FROM forecast_v2_notification_outbox WHERE outbox_id='one'`)
    .bind(leaseUntil)
    .run();
  await db
    .prepare(`CREATE TRIGGER test_fail_exhaustion_alert BEFORE INSERT ON forecast_ops_alerts
      WHEN NEW.alert_key='v2-reconciliation:one'
      BEGIN SELECT RAISE(ABORT,'test_exhaustion_alert_failure'); END`)
    .run();
  await expect(drainV2Outbox(testEnv)).rejects.toThrow("test_exhaustion_alert_failure");
  const retryAt = leaseUntil + 60000;
  const waiting = {
    state: "sending",
    attempts: 10,
    next_attempt_at: retryAt,
    lease_token: "interrupted",
    lease_until: leaseUntil,
  };
  const cleanup = () =>
    db.prepare(`SELECT state,attempts,next_attempt_at,lease_token,lease_until
      FROM forecast_v2_notification_outbox WHERE outbox_id='one'`).first();
  expect(await cleanup()).toEqual(waiting);
  expect(outbound).not.toHaveBeenCalled();

  // The failing alert remains installed: only the other due row may run.
  expect(await drainV2Outbox(testEnv)).toBe(1);
  expect(
    await db
      .prepare("SELECT state,attempts,message_id FROM forecast_v2_notification_outbox WHERE outbox_id='healthy'")
      .first(),
  ).toEqual({ state: "sent", attempts: 1, message_id: messageId });
  expect(await cleanup()).toEqual(waiting);
  expect(outbound).toHaveBeenCalledTimes(1);
  vi.setSystemTime(retryAt - 1);
  expect(await drainV2Outbox(testEnv)).toBe(0);
  expect(await cleanup()).toEqual(waiting);
  await db.prepare("DROP TRIGGER test_fail_exhaustion_alert").run();
  vi.setSystemTime(retryAt);
  expect(await drainV2Outbox(testEnv)).toBe(0);
  const terminal = {
    state: "dead",
    attempts: 10,
    idempotency_key: "key",
    message_id: null,
    channel_id: testEnv.DISCORD_APPROVAL_CHANNEL_ID,
    lease_token: null,
    lease_until: null,
    error_code: "v2_reconciliation_exhausted",
  };
  const stored = () =>
    db.prepare(`SELECT state,attempts,idempotency_key,message_id,channel_id,lease_token,lease_until,error_code
      FROM forecast_v2_notification_outbox WHERE outbox_id='one'`).first();
  expect(await stored()).toEqual(terminal);
  expect(
    await db
      .prepare("SELECT state,error_code FROM forecast_ops_alerts WHERE alert_key='v2-reconciliation:one'")
      .first(),
  ).toEqual({ state: "open", error_code: "v2_reconciliation_exhausted" });
  vi.setSystemTime(now + 3600000);
  expect(await drainV2Outbox(testEnv)).toBe(0);
  expect(await stored()).toEqual(terminal);
  expect(outbound).toHaveBeenCalledTimes(1);
});
