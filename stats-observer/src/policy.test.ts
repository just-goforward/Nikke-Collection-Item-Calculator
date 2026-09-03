import { describe, expect, it } from "vitest";
import { deliveryObservation, failureObservation, nextSeverity } from "./policy";
import type { DeliveryAggregateRow, FailureAggregateRow } from "./types";

describe("stats observer alert policy", () => {
  it("alerts immediately for integrity/runtime exits and escalates capacity on the third event", () => {
    expect(failureObservation(failureRow({ js_exit: "wasm_trap" })).immediateCritical).toBe(true);
    expect(failureObservation(failureRow({ min_ef_exit: "memo_full" })).immediateCritical).toBe(
      false,
    );
    expect(nextSeverity(false, 1)).toBe("warning");
    expect(nextSeverity(false, 3)).toBe("critical");
  });

  it("alerts only for delayed or repeatedly retried delivery summaries", () => {
    expect(deliveryObservation(deliveryRow({ age_bucket: "2m_5m", attempts_bucket: "2" })).alertable).toBe(false);
    expect(deliveryObservation(deliveryRow({ age_bucket: "5m_15m" })).alertable).toBe(true);
    expect(deliveryObservation(deliveryRow({ attempts_bucket: "3_5" })).alertable).toBe(true);
  });
});

function failureRow(overrides: Partial<FailureAggregateRow> = {}): FailureAggregateRow {
  return {
    recovery_version: 2,
    policy_version: "ladder_v2",
    app_revision: "a".repeat(40),
    ingest_revision: "b".repeat(40),
    forecast_id: "supply-test",
    forecast_profile_id: "supply-test@fixed",
    rust_min_ef_solver_version: "rust-min",
    rust_phase2_solver_version: "rust-phase2",
    js_phase2_solver_version: "js-phase2",
    requested_backend: "rust-min-ef",
    min_ef_exit: "memo_full",
    phase2_exit: "not_attempted",
    js_exit: "not_attempted",
    terminal_backend: "none",
    grade: "R",
    level: 0,
    exp_bucket: 0,
    stock_bucket_blue: "500_plus",
    stock_bucket_purple: "300_349",
    stock_bucket_yellow: "150_199",
    browser: "Chrome",
    browser_major: "140",
    os: "Android",
    os_major: "17",
    device_type: "mobile",
    events: 1,
    first_seen: 1_800_000_000,
    last_seen: 1_800_000_000,
    ...overrides,
  };
}

function deliveryRow(overrides: Partial<DeliveryAggregateRow> = {}): DeliveryAggregateRow {
  return {
    outcome: "retried_success",
    event_kind: "solver_recovery",
    attempts_bucket: "1",
    age_bucket: "lt_30s",
    last_failure_class: "network",
    app_revision: "a".repeat(40),
    events: 1,
    first_seen: 1_800_000_000,
    last_seen: 1_800_000_000,
    ...overrides,
  };
}

