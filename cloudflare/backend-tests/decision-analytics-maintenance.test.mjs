import assert from "node:assert/strict";
import test from "node:test";
import {
  maintenanceRows, runDecisionAnalyticsMaintenance, runStatisticsCleanupJobs,
} from "../src/decision-analytics-maintenance.ts";
import { D1DecisionAnalyticsStore } from "../src/decision-analytics-store.ts";

const NOW = Date.parse("2026-11-02T00:00:00Z");
// TEST-ONLY provisioning values; no deployed configuration is registered.
const ready = {
  DECISION_ANALYTICS_MAINTENANCE_ENABLED: "true",
  DECISION_ANALYTICS_SCHEMA_VERSION: "3",
  DECISION_ANALYTICS_MAINTENANCE_ROWS_PER_TABLE: "100",
};
function ports() {
  const calls = [];
  return {
    calls,
    guard: async () => { calls.push("statistics_write"); },
    cleanup: async (now, rows) => { calls.push({ now, rows }); },
  };
}

test("ingestion OFF plus explicit maintenance readiness still runs guarded bounded cleanup", async () => {
  const p = ports();
  await runDecisionAnalyticsMaintenance({ ...ready, DECISION_ANALYTICS_ENABLED: "false" }, NOW, p);
  assert.deepEqual(p.calls, ["statistics_write", { now: NOW, rows: 100 }]);
});
test("malformed producer/ingest config does not disable provisioned maintenance", async () => {
  const p = ports();
  await runDecisionAnalyticsMaintenance({
    ...ready, DECISION_ANALYTICS_ENABLED: "false", DECISION_ANALYTICS_PRODUCERS: "{malformed",
    DECISION_ANALYTICS_PUBLICATION_CONTENT_HASH: undefined, DECISION_ANALYTICS_DAILY_WRITE_ATTEMPTS: undefined,
  }, NOW, p);
  assert.deepEqual(p.calls, ["statistics_write", { now: NOW, rows: 100 }]);
});
test("unprovisioned maintenance/schema/budget is a no-query and no-Guard-call gate", async () => {
  for (const config of [
    {}, { ...ready, DECISION_ANALYTICS_MAINTENANCE_ENABLED: undefined },
    { ...ready, DECISION_ANALYTICS_MAINTENANCE_ENABLED: "false" },
    { ...ready, DECISION_ANALYTICS_SCHEMA_VERSION: undefined },
    { ...ready, DECISION_ANALYTICS_SCHEMA_VERSION: "1" },
    { ...ready, DECISION_ANALYTICS_SCHEMA_VERSION: "2" },
    { ...ready, DECISION_ANALYTICS_MAINTENANCE_ROWS_PER_TABLE: undefined },
    ...["0", "101", "-1", "1.5", "01", "not-a-budget"].map((n) =>
      ({ ...ready, DECISION_ANALYTICS_MAINTENANCE_ROWS_PER_TABLE: n })),
  ]) {
    const p = ports(); await runDecisionAnalyticsMaintenance(config, NOW, p);
    assert.deepEqual(p.calls, []);
    assert.equal(maintenanceRows(config), null);
  }
});
test("existing statistics_write Guard denial still blocks cleanup and propagates", async () => {
  const p = ports(); const denied = new Error("synthetic_guard_denied");
  p.guard = async () => { p.calls.push("statistics_write"); throw denied; };
  await assert.rejects(runDecisionAnalyticsMaintenance(ready, NOW, p), (error) => error === denied);
  assert.deepEqual(p.calls, ["statistics_write"]);
});
test("explicit smaller budget is respected, with no widening of the100/table cap", async () => {
  const p = ports();
  await runDecisionAnalyticsMaintenance({ ...ready, DECISION_ANALYTICS_MAINTENANCE_ROWS_PER_TABLE: "25" }, NOW, p);
  assert.deepEqual(p.calls, ["statistics_write", { now: NOW, rows: 25 }]);
});
test("legacy cleanup failure cannot skip M2 job and retains legacy error reporting", async () => {
  const calls = []; const failure = new Error("synthetic_legacy_failure"); const reports = [];
  await runStatisticsCleanupJobs({
    legacy: async () => { calls.push("legacy"); throw failure; },
    analytics: async () => { calls.push("analytics"); },
    reportLegacy: (error) => { reports.push(["statistics_cleanup_failed", error]); },
    reportAnalytics: (error) => { reports.push(["decision_analytics_cleanup_failed", error]); },
  });
  assert.deepEqual(calls.sort(), ["analytics", "legacy"]);
  assert.deepEqual(reports, [["statistics_cleanup_failed", failure]]);
});
test("both job failures remain separately reported; none is silently swallowed", async () => {
  const legacy = new Error("synthetic_legacy_guard"); const analytics = new Error("synthetic_m2_guard");
  const reports = [];
  await runStatisticsCleanupJobs({
    legacy: async () => { throw legacy; }, analytics: async () => { throw analytics; },
    reportLegacy: (error) => { reports.push(["legacy", error]); },
    reportAnalytics: (error) => { reports.push(["analytics", error]); },
  });
  assert.equal(reports.length, 2);
  assert.ok(reports.some(([job, error]) => job === "legacy" && error === legacy));
  assert.ok(reports.some(([job, error]) => job === "analytics" && error === analytics));
});
test("legacy success/default path still runs once when maintenance is unprovisioned", async () => {
  const calls = []; const p = ports();
  await runStatisticsCleanupJobs({
    legacy: async () => { calls.push("legacy"); },
    analytics: () => runDecisionAnalyticsMaintenance({}, NOW, p),
    reportLegacy: () => { calls.push("unexpected_legacy_error"); },
    reportAnalytics: () => { calls.push("unexpected_m2_error"); },
  });
  assert.deepEqual(calls, ["legacy"]); assert.deepEqual(p.calls, []);
});
test("M2 attempt starts even while legacy is pending; reporter failures are not hidden", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const run = runStatisticsCleanupJobs({
    legacy: () => pending, analytics: async () => { markStarted(); },
    reportLegacy: () => {}, reportAnalytics: () => {},
  });
  await started; release(); await run;
  const reporting = new Error("synthetic_reporting_failure");
  await assert.rejects(runStatisticsCleanupJobs({
    legacy: async () => { throw new Error("synthetic_legacy_failure"); }, analytics: async () => {},
    reportLegacy: () => { throw reporting; }, reportAnalytics: () => {},
  }), (error) => error === reporting);
});

class CaptureDatabase {
  statements = []; batches = [];
  prepare(sql) {
    const item = { sql, args: [], bind(...args) { this.args = args; return this; }, async first() { return null; } };
    this.statements.push(item); return item;
  }
  async batch(statements) { this.batches.push(statements); return statements.map(() => ({ results: [] })); }
}
test("real cleanup adapter keeps one bounded five-statement batch with approved local row limit", async () => {
  const db = new CaptureDatabase(); const store = new D1DecisionAnalyticsStore(db);
  const p = { guard: async () => {}, cleanup: (now, rows) => store.cleanup(now, rows) };
  await runDecisionAnalyticsMaintenance({
    ...ready, DECISION_ANALYTICS_MAINTENANCE_ROWS_PER_TABLE: "25",
  }, NOW, p);
  assert.equal(db.batches.length, 1); assert.equal(db.batches[0].length, 5);
  assert.equal(db.batches[0].filter((s) => s.sql.startsWith("DELETE ")).length, 4);
  assert.ok(db.batches[0].slice(0, 4).every((s) => /ORDER BY expires_at LIMIT 25/.test(s.sql)));
  assert.ok(db.batches[0].slice(0, 4).every((s) => s.args[0] === NOW));
  assert.match(db.batches[0][4].sql, /last_success_ms/);
});
test("invalid direct adapter budgets fail before any statement or batch", async () => {
  for (const rows of [0, 101, -1, 1.5, NaN]) {
    const db = new CaptureDatabase();
    await assert.rejects(new D1DecisionAnalyticsStore(db).cleanup(NOW, rows), /analytics_cleanup_budget_invalid/);
    assert.equal(db.statements.length, 0); assert.equal(db.batches.length, 0);
  }
});
