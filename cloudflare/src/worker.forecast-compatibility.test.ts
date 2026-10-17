import { afterEach, beforeEach, describe, expect, it } from "vitest";
import compat from "../../shared/supplyForecastCompatIdentities.json";
import { solverDiagnosticEvent, solverRecoveryEvent } from "./worker.test-events";
import { WorkerTestHarness } from "./worker.test-harness";

const harness = new WorkerTestHarness();
beforeEach(() => harness.setup());
afterEach(() => harness.teardown());

describe("pinned forecast compatibility", () => {
  it.each([solverDiagnosticEvent, solverRecoveryEvent])("accepts v3 identities", async (make) => {
    for (const [index, profile] of compat.profileIds.entries()) {
      const payload = make(`compat-identity-${index}`);
      const event = { ...payload.event, forecastId: compat.forecastId, forecastProfileId: profile };
      expect((await harness.submit({ ...payload, event })).status).toBe(200);
    }
    await expect(harness.countRows("event_ids")).resolves.toBe(42);
  });

  it.each([solverDiagnosticEvent, solverRecoveryEvent])(
    "rejects unknown identities",
    async (make) => {
      for (const field of ["forecastId", "forecastProfileId"]) {
        const payload = make(`unknown-identity-${field}`);
        const event = { ...payload.event, [field]: "supply-2099-01-01-v1@unknown" };
        expect((await harness.submit({ ...payload, event })).status).toBe(400);
      }
      await expect(harness.countRows("event_ids")).resolves.toBe(0);
    },
  );
});
