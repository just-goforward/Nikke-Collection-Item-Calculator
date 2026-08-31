import { createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import schemaSql from "../schema.sql?raw";
import type { CollectorEnv } from "./types";
import worker from "./worker";

const testEnv: CollectorEnv = {
  FORECAST_DB: env.FORECAST_DB,
  ADMIN_RATE_LIMITER: env.ADMIN_RATE_LIMITER,
  ADMIN_TOKEN: env.ADMIN_TOKEN,
  ENVIRONMENT: "test",
  DEPLOY_SHA: env.DEPLOY_SHA,
  POLL_MODE: "both",
  DISCORD_APPROVAL_MODE: "test",
};
type WorkerFetch = NonNullable<typeof worker.fetch>;
type WorkerRequest = Parameters<WorkerFetch>[0];

beforeEach(async () => {
  await reset();
  for (const statement of schemaSql
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    await testEnv.FORECAST_DB.prepare(statement).run();
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
