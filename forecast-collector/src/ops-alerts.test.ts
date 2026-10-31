import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { executeTestSql } from "../../shared/testD1Sql";
import {
  resolveBudgetIncidentsBeforeStatement,
  resolveOpsAlertsByPrefix,
  sanitizeOpsError,
  upsertOpsAlert,
  upsertOpsAlertStatement,
} from "./ops";
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

it("resets affected streams when a closed budget incident reopens under the same key", async () => {
  const db = env.FORECAST_DB;
  const incident = {
    alertKey: "forecast-v2:staging:budget:metadata:2026-10-18",
    environment: "staging" as const,
    severity: "warning" as const,
    component: "collector",
    errorCode: "budget_exhausted",
    context: {
      gameDay: "2026-10-18",
      kind: "metadata",
      used: 240,
      limit: 240,
      resetAt: "2026-10-18T20:00:00.000Z",
      affectedStreams: "A",
    },
    mergeAffectedStream: "A",
  };
  await upsertOpsAlert(db, { ...incident, nowMs: Date.parse("2026-10-18T10:00:00.000Z") });
  await upsertOpsAlert(db, {
    ...incident,
    mergeAffectedStream: "B",
    nowMs: Date.parse("2026-10-18T10:01:00.000Z"),
  });
  const streams = async () => {
    const row = await db
      .prepare("SELECT context_json FROM forecast_ops_alerts WHERE alert_key=?")
      .bind(incident.alertKey)
      .first<{ context_json: string }>();
    if (!row) throw new Error("incident_missing");
    return JSON.parse(row.context_json) as { affectedStreams?: string; gameDay?: string };
  };
  expect((await streams()).affectedStreams).toBe("A,B");

  await resolveBudgetIncidentsBeforeStatement(
    db,
    "staging",
    "2026-10-19",
    Date.parse("2026-10-18T20:00:00.000Z"),
  ).run();
  // A reopen starts a new occurrence: stale streams from the closed run must not leak in.
  await upsertOpsAlert(db, {
    ...incident,
    context: { ...incident.context, gameDay: "2026-10-19" },
    mergeAffectedStream: "C",
    nowMs: Date.parse("2026-10-19T09:00:00.000Z"),
  });
  expect(await streams()).toMatchObject({ gameDay: "2026-10-19", affectedStreams: "C" });
});

const SENTINEL = "SENTINEL_secret_9f3a";

it("sanitizes a caught value to a registered code and never to its message text", () => {
  // Registered codes and fixed vocabulary survive: they are the operator's signal.
  expect(sanitizeOpsError(new Error("canary_run_conflict"))).toBe("canary_run_conflict");
  expect(sanitizeOpsError(new Error("D1_ERROR: no such table: forecast_ops_alerts"))).toBe(
    "D1_ERROR",
  );
  const timeout = new Error(`${SENTINEL} aborted`);
  timeout.name = "TimeoutError";
  expect(sanitizeOpsError(timeout)).toBe("TimeoutError");
  // A fixed runtime error name is vocabulary, not text: it is kept, its message is not.
  expect(sanitizeOpsError(new TypeError(`cannot read ${SENTINEL}`))).toBe("TypeError");
  // Arbitrary text — including a driver error that raised a registered trigger — collapses
  // to the fixed policy code, so no message fragment can reach D1 or a rendered alert.
  for (const error of [
    new Error(`naver fetch failed for token=${SENTINEL}`),
    new Error(SENTINEL),
    { message: SENTINEL },
    SENTINEL,
    undefined,
  ])
    expect(sanitizeOpsError(error)).toBe("forecast_ops_unknown_error");
  expect(sanitizeOpsError(new Error(JSON.stringify({ secret: SENTINEL })))).not.toContain(SENTINEL);
});

it("stores only a sanitized code when an ops alert is raised from a caught error", async () => {
  const db = env.FORECAST_DB;
  const persisted = sanitizeOpsError(new Error(`upstream rejected key=${SENTINEL}`));
  await upsertOpsAlert(db, {
    alertKey: "collector-error:staging",
    environment: "staging",
    severity: "warning",
    component: "collector",
    errorCode: persisted,
  });
  const row = await db
    .prepare("SELECT error_code FROM forecast_ops_alerts WHERE alert_key='collector-error:staging'")
    .first<{ error_code: string }>();
  expect(row?.error_code).toBe("forecast_ops_unknown_error");
  expect(row?.error_code).not.toContain(SENTINEL);
  // The D1 row is what the dispatcher renders into Discord; the sentinel is not present.
  const rendered = JSON.stringify(
    (
      await db
        .prepare("SELECT * FROM forecast_ops_alerts WHERE alert_key='collector-error:staging'")
        .all()
    ).results,
  );
  expect(rendered).not.toContain(SENTINEL);
});
