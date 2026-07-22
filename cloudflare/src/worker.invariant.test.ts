import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runtimeInvariantEvent } from "./worker.test-events";
import { WorkerTestHarness } from "./worker.test-harness";

const harness = new WorkerTestHarness();

beforeEach(async () => {
  await harness.setup();
});

afterEach(async () => {
  await harness.teardown();
});

describe("runtime_invariant event commit", () => {
  it("stores only bucketed invariant dimensions and exposes them privately", async () => {
    const response = await harness.submit(runtimeInvariantEvent("runtime-invariant-event1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const aggregate = await harness.database
      .prepare(
        `SELECT invariant_version, invariant_code, component, lane, device_type, events
         FROM runtime_invariant_aggregates`,
      )
      .first<{
        invariant_version: number;
        invariant_code: string;
        component: string;
        lane: string;
        device_type: string;
        events: number;
      }>();
    expect(aggregate).toEqual({
      invariant_version: 1,
      invariant_code: "worker_idle_pending",
      component: "worker_client",
      lane: "validation",
      device_type: "unknown",
      events: 1,
    });

    const admin = await harness.fetchAdminSolverDiagnostics();
    const body = (await admin.json()) as {
      runtimeInvariants?: Array<Record<string, unknown>>;
      runtimeInvariantDataPolicy?: Record<string, unknown>;
    };
    expect(body.runtimeInvariants).toEqual([
      expect.objectContaining({
        invariantVersion: 1,
        code: "worker_idle_pending",
        component: "worker_client",
        lane: "validation",
        events: 1,
      }),
    ]);
    expect(body.runtimeInvariantDataPolicy).toEqual({
      bucketedOnly: true,
      rawErrorsStored: false,
    });
  });
});
