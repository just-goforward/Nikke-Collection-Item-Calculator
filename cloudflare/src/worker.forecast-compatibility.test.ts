import { afterEach, beforeEach, describe, expect, it } from "vitest";
import compat from "../../shared/supplyForecastCompatIdentities.json";
import {
  FORECAST_COMPATIBILITY_CASES,
  solverDiagnosticEvent,
  solverRecoveryEvent,
} from "./worker.test-events";
import { WorkerTestHarness } from "./worker.test-harness";

const harness = new WorkerTestHarness();
beforeEach(() => harness.setup());
afterEach(() => harness.teardown());

describe("stats forecast rollout compatibility", () => {
  it.each(FORECAST_COMPATIBILITY_CASES)(
    "commits both diagnostic and recovery events for the $name site",
    async (identity) => {
      const diagnostic = solverDiagnosticEvent(`diagnostic-rollout-${identity.name}`, identity);
      const recovery = solverRecoveryEvent(`recovery-rollout-${identity.name}`, identity);
      expect((await harness.submit(diagnostic)).status).toBe(200);
      expect((await harness.submit(recovery)).status).toBe(200);
      await expect(harness.countRows("event_ids")).resolves.toBe(2);
      const diagnosticRow = await harness.database
        .prepare("SELECT forecast_id FROM solver_diagnostic_aggregates_game_day")
        .first<{ forecast_id: string }>();
      const recoveryRow = await harness.database
        .prepare("SELECT forecast_id FROM solver_recovery_terminal_aggregates_game_day")
        .first<{ forecast_id: string }>();
      expect(diagnosticRow).toEqual({ forecast_id: identity.forecastId });
      expect(recoveryRow).toEqual({ forecast_id: identity.forecastId });
    },
  );

  it.each([
    { name: "diagnostic", makeEvent: solverDiagnosticEvent },
    { name: "recovery", makeEvent: solverRecoveryEvent },
  ])("rejects unknown $name forecast IDs and profiles without committing events", async (row) => {
    for (const [field, value, error] of [
      ["forecastId", "supply-2099-01-01-v1", "invalid_supply_forecast"],
      ["forecastProfileId", "supply-2099-01-01-v1@unknown", "invalid_supply_forecast_profile"],
    ] as const) {
      const payload = row.makeEvent(`unknown-${row.name}-${field}`);
      payload.event[field] = value;
      const response = await harness.submit(payload);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error });
    }
    await expect(harness.countRows("event_ids")).resolves.toBe(0);
    await expect(harness.countRows("solver_diagnostic_aggregates_game_day")).resolves.toBe(0);
    await expect(harness.countRows("solver_recovery_terminal_aggregates_game_day")).resolves.toBe(
      0,
    );
  });
});

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
