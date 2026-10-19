import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { executeTestSql } from "../../shared/testD1Sql";
import { resolveOpsAlertsByPrefix, upsertOpsAlert, upsertOpsAlertStatement } from "./ops";
import schemaSql from "./test-schema";

beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schemaSql, applyD1Migrations);
});

it("preserves open delivery state and resets it only when reopening with a monotonic identity", async () => {
  const db = env.FORECAST_DB;
  const now = Date.parse("2026-09-01T23:59:59.999Z");
  const input = {
    alertKey: "collector-recurrence:staging",
    environment: "staging" as const,
    severity: "critical" as const,
    component: "collector",
    errorCode: "test_failure",
    notifyAfterCount: 3,
  };
  await upsertOpsAlert(db, { ...input, nowMs: now });
  const sentAt = new Date(now).toISOString();
  const suppressedUntil = new Date(now + 30 * 60 * 1_000).toISOString();
  await db
    .prepare(
      `UPDATE forecast_ops_alerts
       SET last_sent_at = ?, last_sent_occurrence_count = 1, discord_message_id = ?,
           next_send_at = ?
       WHERE alert_key = ?`,
    )
    .bind(sentAt, "123456789012345678", suppressedUntil, input.alertKey)
    .run();
  await upsertOpsAlertStatement(db, { ...input, nowMs: now + 1 }).run();
  const read = () =>
    db
      .prepare(
        `SELECT state, occurrence_count, notify_after_count, first_seen_at,
                last_sent_at, last_sent_occurrence_count, discord_message_id,
                next_send_at, resolved_at, recovery_sent_at, last_send_error
         FROM forecast_ops_alerts WHERE alert_key = ?`,
      )
      .bind(input.alertKey)
      .first();
  expect(await read()).toMatchObject({
    state: "open",
    occurrence_count: 2,
    notify_after_count: 3,
    first_seen_at: sentAt,
    last_sent_at: sentAt,
    last_sent_occurrence_count: 1,
    discord_message_id: "123456789012345678",
    next_send_at: suppressedUntil,
  });
  for (const [reopenAt, firstSeenAt] of [
    [now, now + 1],
    [now - 1_000, now + 2],
    [now + 10_000, now + 10_000],
  ] as const) {
    await resolveOpsAlertsByPrefix(db, input.alertKey, reopenAt);
    await db
      .prepare(
        `UPDATE forecast_ops_alerts SET recovery_sent_at = ?, last_send_error = ?
         WHERE alert_key = ?`,
      )
      .bind(sentAt, "old_failure", input.alertKey)
      .run();
    await upsertOpsAlert(db, { ...input, nowMs: reopenAt });
    expect(await read()).toEqual({
      state: "open",
      occurrence_count: 1,
      notify_after_count: 3,
      first_seen_at: new Date(firstSeenAt).toISOString(),
      last_sent_at: null,
      last_sent_occurrence_count: 0,
      discord_message_id: null,
      next_send_at: new Date(reopenAt).toISOString(),
      resolved_at: null,
      recovery_sent_at: null,
      last_send_error: null,
    });
  }
});
