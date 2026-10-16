import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTestSql } from "../../shared/testD1Sql";
import { resolveOpsAlertsByPrefix, upsertOpsAlert, upsertOpsAlertStatement } from "./ops";
import schemaSql from "./test-schema";
import { seedNormalUsageGuard } from "./test-usage-guard";
import type { CollectorEnv } from "./types";
import worker from "./worker";

const testEnv: CollectorEnv = {
  FORECAST_DB: env.FORECAST_DB,
  USAGE_GUARD_DB: env.USAGE_GUARD_DB,
  ADMIN_RATE_LIMITER: env.ADMIN_RATE_LIMITER,
  ADMIN_TOKEN: env.ADMIN_TOKEN,
  ENVIRONMENT: "test",
  DEPLOY_SHA: env.DEPLOY_SHA,
  POLL_MODE: "both",
  DISCORD_APPROVAL_MODE: "test",
};
type WorkerFetch = NonNullable<typeof worker.fetch>;
type WorkerRequest = Parameters<WorkerFetch>[0];

const deniedFetch = vi.fn(async () => {
  throw new Error("Unexpected outbound fetch in collector operations tests.");
});

beforeEach(async () => {
  deniedFetch.mockClear();
  vi.stubGlobal("fetch", deniedFetch);
  await reset();
  await executeTestSql(testEnv.FORECAST_DB, schemaSql, applyD1Migrations);
  await seedNormalUsageGuard(testEnv.USAGE_GUARD_DB);
});

afterEach(() => {
  try {
    expect(deniedFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("dispatcher smoke and workflow callbacks", () => {
  it("creates one staging smoke and accepts idempotent callbacks from one run", async () => {
    const smoke = await admin("/admin/dispatcher-smoke", {
      method: "POST",
      body: JSON.stringify({ requestKey: "deploy:abc:123" }),
    });
    expect(smoke.status).toBe(202);
    const created = (await smoke.json()) as { dispatchId: string; state: string };
    expect(created).toMatchObject({ state: "pending" });
    await testEnv.FORECAST_DB.prepare(
      "UPDATE workflow_dispatches SET state = 'accepted', accepted_at = ? WHERE dispatch_id = ?",
    )
      .bind(new Date().toISOString(), created.dispatchId)
      .run();

    const startedBody = {
      phase: "started",
      runId: 123456,
      runAttempt: 1,
      runUrl:
        "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/123456",
    };
    const started = await admin(`/admin/workflow-dispatches/${created.dispatchId}/status`, {
      method: "POST",
      body: JSON.stringify(startedBody),
    });
    const repeated = await admin(`/admin/workflow-dispatches/${created.dispatchId}/status`, {
      method: "POST",
      body: JSON.stringify(startedBody),
    });
    expect(started.status).toBe(200);
    expect(repeated.status).toBe(200);

    const finishedBody = { ...startedBody, phase: "finished", conclusion: "success" };
    const finished = await admin(`/admin/workflow-dispatches/${created.dispatchId}/status`, {
      method: "POST",
      body: JSON.stringify(finishedBody),
    });
    const repeatedFinish = await admin(`/admin/workflow-dispatches/${created.dispatchId}/status`, {
      method: "POST",
      body: JSON.stringify(finishedBody),
    });
    expect(finished.status).toBe(200);
    expect(repeatedFinish.status).toBe(200);

    const status = await admin(`/admin/workflow-dispatches/${created.dispatchId}/status`);
    expect(await status.json()).toMatchObject({
      dispatch: {
        dispatchId: created.dispatchId,
        mode: "smoke",
        state: "succeeded",
        runId: 123456,
      },
    });
  });

  it("rejects a second GitHub run identity for the same dispatch ID and records an alert", async () => {
    const smoke = await admin("/admin/dispatcher-smoke", {
      method: "POST",
      body: JSON.stringify({ requestKey: "deploy:abc:duplicate" }),
    });
    const created = (await smoke.json()) as { dispatchId: string };
    await testEnv.FORECAST_DB.prepare(
      "UPDATE workflow_dispatches SET state = 'accepted', accepted_at = ? WHERE dispatch_id = ?",
    )
      .bind(new Date().toISOString(), created.dispatchId)
      .run();
    await admin(`/admin/workflow-dispatches/${created.dispatchId}/status`, {
      method: "POST",
      body: JSON.stringify({
        phase: "started",
        runId: 111,
        runAttempt: 1,
        runUrl:
          "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/111",
      }),
    });

    const conflict = await admin(`/admin/workflow-dispatches/${created.dispatchId}/status`, {
      method: "POST",
      body: JSON.stringify({
        phase: "started",
        runId: 222,
        runAttempt: 1,
        runUrl:
          "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/222",
      }),
    });
    expect(conflict.status).toBe(409);
    const alert = await testEnv.FORECAST_DB.prepare(
      "SELECT component, error_code FROM forecast_ops_alerts WHERE component = 'workflow-callback'",
    ).first<{ component: string; error_code: string }>();
    expect(alert).toEqual({
      component: "workflow-callback",
      error_code: "workflow_dispatch_run_identity_conflict",
    });
  });

  it("rejects a finished callback before the workflow has started", async () => {
    const smoke = await admin("/admin/dispatcher-smoke", {
      method: "POST",
      body: JSON.stringify({ requestKey: "deploy:abc:state-regression" }),
    });
    const created = (await smoke.json()) as { dispatchId: string };
    await testEnv.FORECAST_DB.prepare(
      "UPDATE workflow_dispatches SET state = 'accepted', accepted_at = ? WHERE dispatch_id = ?",
    )
      .bind(new Date().toISOString(), created.dispatchId)
      .run();

    const regressed = await admin(`/admin/workflow-dispatches/${created.dispatchId}/status`, {
      method: "POST",
      body: JSON.stringify({
        phase: "finished",
        runId: 555,
        runAttempt: 1,
        runUrl:
          "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/555",
        conclusion: "success",
      }),
    });

    expect(regressed.status).toBe(409);
    expect(await regressed.json()).toEqual({ error: "workflow_dispatch_state_regression" });
    const row = await testEnv.FORECAST_DB.prepare(
      "SELECT state, github_run_id FROM workflow_dispatches WHERE dispatch_id = ?",
    )
      .bind(created.dispatchId)
      .first<{ state: string; github_run_id: number | null }>();
    expect(row).toEqual({ state: "accepted", github_run_id: null });
  });

  it.each(["failure", "cancelled"] as const)(
    "records a typed critical alert when the GitHub workflow finishes with %s",
    async (conclusion) => {
      const smoke = await admin("/admin/dispatcher-smoke", {
        method: "POST",
        body: JSON.stringify({ requestKey: `deploy:abc:${conclusion}` }),
      });
      const created = (await smoke.json()) as { dispatchId: string };
      await testEnv.FORECAST_DB.prepare(
        "UPDATE workflow_dispatches SET state = 'accepted', accepted_at = ? WHERE dispatch_id = ?",
      )
        .bind(new Date().toISOString(), created.dispatchId)
        .run();
      const identity = {
        runId: conclusion === "failure" ? 333 : 444,
        runAttempt: 1,
      };
      const runUrl = `https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/${identity.runId}`;
      await admin(`/admin/workflow-dispatches/${created.dispatchId}/status`, {
        method: "POST",
        body: JSON.stringify({ phase: "started", ...identity, runUrl }),
      });
      const finished = await admin(`/admin/workflow-dispatches/${created.dispatchId}/status`, {
        method: "POST",
        body: JSON.stringify({ phase: "finished", ...identity, runUrl, conclusion }),
      });
      expect(finished.status).toBe(200);
      const row = await testEnv.FORECAST_DB.prepare(
        "SELECT state, error_code FROM workflow_dispatches WHERE dispatch_id = ?",
      )
        .bind(created.dispatchId)
        .first<{ state: string; error_code: string }>();
      const expectedState = conclusion === "failure" ? "failed" : "cancelled";
      expect(row).toEqual({ state: expectedState, error_code: `github_workflow_${expectedState}` });
      const alert = await testEnv.FORECAST_DB.prepare(
        "SELECT severity, error_code FROM forecast_ops_alerts WHERE alert_key = ?",
      )
        .bind(`workflow:staging:${created.dispatchId}`)
        .first<{ severity: string; error_code: string }>();
      expect(alert).toEqual({
        severity: "critical",
        error_code: `github_workflow_${expectedState}`,
      });
    },
  );
});

describe("operations alert recurrence identity", () => {
  it("preserves open delivery state and resets it only when reopening with a monotonic identity", async () => {
    const now = Date.parse("2026-09-01T23:59:59.999Z");
    const input = {
      alertKey: "collector-recurrence:staging",
      environment: "staging" as const,
      severity: "critical" as const,
      component: "collector",
      errorCode: "test_failure",
      notifyAfterCount: 3,
    };
    await upsertOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now });
    const sentAt = new Date(now).toISOString();
    const suppressedUntil = new Date(now + 30 * 60 * 1_000).toISOString();
    await testEnv.FORECAST_DB.prepare(
      `UPDATE forecast_ops_alerts
       SET last_sent_at = ?, last_sent_occurrence_count = 1, discord_message_id = ?,
           next_send_at = ?
       WHERE alert_key = ?`,
    )
      .bind(sentAt, "123456789012345678", suppressedUntil, input.alertKey)
      .run();
    await upsertOpsAlertStatement(testEnv.FORECAST_DB, { ...input, nowMs: now + 1 }).run();

    const read = () =>
      testEnv.FORECAST_DB.prepare(
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
      await resolveOpsAlertsByPrefix(testEnv.FORECAST_DB, input.alertKey, reopenAt);
      await testEnv.FORECAST_DB.prepare(
        `UPDATE forecast_ops_alerts SET recovery_sent_at = ?, last_send_error = ?
         WHERE alert_key = ?`,
      )
        .bind(sentAt, "old_failure", input.alertKey)
        .run();
      await upsertOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: reopenAt });
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
});

async function admin(path: string, init: RequestInit = {}) {
  const handler = worker.fetch;
  if (!handler) throw new Error("Missing Worker fetch handler.");
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer test-forecast-admin-token");
  headers.set("content-type", "application/json");
  return handler(
    new Request(`https://collector.test${path}`, { ...init, headers }) as WorkerRequest,
    testEnv,
    createExecutionContext(),
  );
}
