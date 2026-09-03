import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOLVER_RECOVERY_SOLVER_VERSIONS } from "../../shared/solverRecoveryContract";
import { solverRecoveryEvent } from "./worker.test-events";
import { WorkerTestHarness } from "./worker.test-harness";
import type { AdminDiagnosticsBody } from "./worker.test-types";

const harness = new WorkerTestHarness();
const submit = (payload: object) => harness.submit(payload);
const countRows = (table: string) => harness.countRows(table);
const fetchAdminSolverDiagnostics = () => harness.fetchAdminSolverDiagnostics();

beforeEach(async () => {
  await harness.setup();
});

afterEach(async () => {
  await harness.teardown();
});

describe("solver_recovery event commit", () => {
  it("writes bucketed rung and terminal aggregates without raw attempt identifiers", async () => {
    const response = await submit(solverRecoveryEvent("solver-recovery-valid1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await expect(countRows("solver_recovery_rung_aggregates_game_day")).resolves.toBe(2);
    await expect(countRows("solver_recovery_terminal_aggregates_game_day")).resolves.toBe(1);
    const terminal = await harness.database
      .prepare(
        `SELECT forecast_id, policy_version, requested_backend, min_ef_exit, phase2_exit,
                terminal_backend, terminal_outcome, device_type
         FROM solver_recovery_terminal_aggregates_game_day`,
      )
      .first<{
        forecast_id: string;
        policy_version: string;
        requested_backend: string;
        min_ef_exit: string;
        phase2_exit: string;
        terminal_backend: string;
        terminal_outcome: string;
        device_type: string;
      }>();
    expect(terminal).toEqual({
      forecast_id: "supply-2026-08-21-v1",
      policy_version: "ladder_v1",
      requested_backend: "rust-min-ef",
      min_ef_exit: "memo_full",
      phase2_exit: "success",
      terminal_backend: "rust-phase2",
      terminal_outcome: "success",
      device_type: "unknown",
    });

    const admin = (await (await fetchAdminSolverDiagnostics()).json()) as AdminDiagnosticsBody;
    expect(admin.recoveryRungs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          forecastId: "supply-2026-08-21-v1",
          policyVersion: "ladder_v1",
          rungBackend: "rust-min-ef",
          rungExit: "memo_full",
          events: 1,
        }),
      ]),
    );
    expect(admin.recoveryTerminals).toEqual([
      expect.objectContaining({
        forecastId: "supply-2026-08-21-v1",
        policyVersion: "ladder_v1",
        terminalBackend: "rust-phase2",
        terminalOutcome: "success",
        events: 1,
      }),
    ]);
  });

  it("writes v2 terminal failures to the operational failure index", async () => {
    const payload = solverRecoveryEvent("solver-recovery-v2-fail1");
    Object.assign(payload.event, {
      recoveryVersion: 2,
      policyVersion: "ladder_v2",
      appRevision: "a".repeat(40),
      solverVersions: SOLVER_RECOVERY_SOLVER_VERSIONS,
      phase2Exit: "memory_limit",
      terminalBackend: "none",
      terminalOutcome: "failure",
    });

    const response = await submit(payload);

    expect(response.status).toBe(200);
    await expect(countRows("solver_failure_aggregates_game_day")).resolves.toBe(1);
    const row = await harness.database
      .prepare(
        `SELECT app_revision, ingest_revision, forecast_profile_id,
                rust_min_ef_solver_version, rust_phase2_solver_version,
                js_phase2_solver_version, browser, os, events
         FROM solver_failure_aggregates_game_day`,
      )
      .first<Record<string, string | number>>();
    expect(row).toMatchObject({
      app_revision: "a".repeat(40),
      ingest_revision: "unknown",
      forecast_profile_id: "supply-2026-08-21-v1@fixed",
      rust_min_ef_solver_version: SOLVER_RECOVERY_SOLVER_VERSIONS.rustMinEf,
      rust_phase2_solver_version: SOLVER_RECOVERY_SOLVER_VERSIONS.rustPhase2,
      js_phase2_solver_version: SOLVER_RECOVERY_SOLVER_VERSIONS.jsPhase2,
      browser: "Unknown",
      os: "Unknown",
      events: 1,
    });
    const admin = (await (await fetchAdminSolverDiagnostics()).json()) as AdminDiagnosticsBody;
    expect(admin.operationalFailures?.rows).toEqual([
      expect.objectContaining({
        recoveryVersion: 2,
        policyVersion: "ladder_v2",
        appRevision: "a".repeat(40),
        events: 1,
      }),
    ]);
    expect(admin.recoveryDataPolicy).toMatchObject({
      operationalFailuresAreBucketed: true,
      exactStockStored: false,
    });
    expect(admin.observerCoverage).toEqual({
      availableInThisResponse: false,
      source: "separate_stats_observer_d1",
      auditWorkflow: "Audit Solver Recovery History",
    });
  });
});

describe("solver_recovery operational telemetry", () => {
  it("does not write successful fallback events to the failure-only index", async () => {
    expect((await submit(solverRecoveryEvent("solver-recovery-success2"))).status).toBe(200);
    await expect(countRows("solver_failure_aggregates_game_day")).resolves.toBe(0);
  });

  it("records post-Turnstile recovery contract rejections once", async () => {
    const payload = solverRecoveryEvent("solver-recovery-badpolicy");
    payload.event.policyVersion = "ladder_future";

    const first = await submit(payload);
    const duplicate = await submit(payload);

    expect(first.status).toBe(400);
    await expect(first.json()).resolves.toEqual({ error: "unsupported_recovery_policy" });
    expect(duplicate.status).toBe(400);
    await expect(countRows("stats_rejection_event_ids")).resolves.toBe(1);
    const row = await harness.database
      .prepare(
        `SELECT rejection_code, event_kind, recovery_version, policy_version, events
         FROM stats_submission_rejection_aggregates_game_day`,
      )
      .first<Record<string, string | number>>();
    expect(row).toEqual({
      rejection_code: "unsupported_recovery_policy",
      event_kind: "solver_recovery",
      recovery_version: "1",
      policy_version: "unsupported",
      events: 1,
    });
    const admin = (await (await fetchAdminSolverDiagnostics()).json()) as AdminDiagnosticsBody;
    expect(admin.submissionHealth?.rejections.rows).toEqual([
      expect.objectContaining({
        rejectionCode: "unsupported_recovery_policy",
        eventKind: "solver_recovery",
        events: 1,
      }),
    ]);
  });

  it("does not recount a rejected event ID under a different rejection code", async () => {
    const payload = solverRecoveryEvent("solver-recovery-reused-id1");
    payload.event.policyVersion = "ladder_future";
    expect((await submit(payload)).status).toBe(400);

    payload.event.policyVersion = "ladder_v2";
    payload.event.recoveryVersion = 99;
    expect((await submit(payload)).status).toBe(400);

    await expect(countRows("stats_rejection_event_ids")).resolves.toBe(1);
    const rows = await harness.database
      .prepare(
        `SELECT rejection_code, events
         FROM stats_submission_rejection_aggregates_game_day
         ORDER BY rejection_code`,
      )
      .all<Record<string, string | number>>();
    expect(rows.results).toEqual([{ rejection_code: "unsupported_recovery_policy", events: 1 }]);
  });

  it("keeps a rejected event retryable when rejection evidence cannot be stored", async () => {
    await harness.database.exec("DROP TABLE stats_submission_rejection_aggregates_game_day");
    const payload = solverRecoveryEvent("solver-recovery-storage-fail");
    payload.event.policyVersion = "ladder_future";

    const response = await submit(payload);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "rejection_storage_unavailable",
      retryable: true,
    });
  });

  it("commits bucketed delivery health with the accepted event", async () => {
    const payload = solverRecoveryEvent("solver-recovery-delivery1");
    Object.assign(payload, {
      deliveryHealth: {
        outcome: "retried_success",
        eventKind: "kit_result",
        appRevision: "c".repeat(40),
        attempts: "3_5",
        age: "5m_15m",
        lastFailureClass: "network",
        events: 2,
      },
    });

    expect((await submit(payload)).status).toBe(200);
    const row = await harness.database
      .prepare(
        `SELECT outcome, event_kind, attempts_bucket, age_bucket,
                last_failure_class, app_revision, events
         FROM stats_delivery_health_aggregates_game_day`,
      )
      .first<Record<string, string | number>>();
    expect(row).toEqual({
      outcome: "retried_success",
      event_kind: "kit_result",
      attempts_bucket: "3_5",
      age_bucket: "5m_15m",
      last_failure_class: "network",
      app_revision: "c".repeat(40),
      events: 2,
    });
    const admin = (await (await fetchAdminSolverDiagnostics()).json()) as AdminDiagnosticsBody;
    expect(admin.submissionHealth?.delivery.rows).toEqual([
      expect.objectContaining({
        outcome: "retried_success",
        ageBucket: "5m_15m",
        events: 2,
      }),
    ]);
  });
});
