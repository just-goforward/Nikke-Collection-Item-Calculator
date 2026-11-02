import assert from "node:assert/strict";
import test from "node:test";
import { handleOutcomeAnalytics } from "../src/outcome-handler.ts";
import { D1OutcomeStore } from "../src/outcome-store.ts";
import { resolveOutcomePublication } from "../src/outcome-publication.ts";
import { prepareOutcomePublication } from "../src/outcome-public-store.ts";
import { cleanupExpiredStatistics } from "../src/rate-limit.ts";
import { handleDecisionAnalytics } from "../src/decision-analytics-handler.ts";
import { HttpError } from "../src/http-error.ts";
import { SQLiteD1 } from "./sqlite-d1.mjs";
import { CONFIG, NOW, commit, id, legacy, patch, publicFixture } from "./outcome-fixture.mjs";

const publicationPromise = publicFixture();
async function fixture(t) {
  const publication = await publicationPromise;
  const db = new SQLiteD1(NOW);
  t.after(() => db.close());
  t.mock.method(globalThis, "fetch", () => { throw new Error("OUTCOME_TEST_OUTBOUND_DENIED"); });
  db.apply("../schema.sql");
  db.apply("../decision-analytics/0002_stats_public_read_models.proposed.sql");
  db.apply("../decision-analytics/0003_outcome_facts.proposed.sql");
  db.sqlite.prepare("UPDATE outcome_maintenance SET last_success_ms=?").run(NOW);
  const store = new D1OutcomeStore(db), calls = [];
  const lookup = store.lookup.bind(store);
  store.lookup = async (...args) => { calls.push("lookup"); return lookup(...args); };
  const ports = {
    now: () => db.now, nonce: () => crypto.randomUUID(), allowed: () => true,
    readPayload: request => request.json(),
    limit: async () => { calls.push("rate"); }, verify: async () => { calls.push("turnstile"); },
    guard: async () => { calls.push("guard"); }, store: () => store,
    authorize: async () => publication.prepared,
    respond: (body, status) => Response.json(body, { status }),
    expectedError: error => error instanceof HttpError
      ? { status: error.status, code: error.message, retryable: error.retryable === true } : null,
  };
  const send = (event, config = CONFIG) => handleOutcomeAnalytics(new Request("https://unit.invalid/api/decision-outcomes", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...event, turnstileToken: "TEST-ONLY-fresh-security-token" }),
  }), config, ports);
  return { db, store, ports, calls, send, publication };
}
function row(db, sql) { const value = db.sqlite.prepare(sql).get(); return value ? { ...value } : null; }
function count(db, table) { return db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n; }

test("maintenance denials retain nonretryable classification while unknown health errors stay sanitized", async t => {
  const f = await fixture(t), event = commit(f.publication);
  let attempts = 0;
  for (const lastSuccess of [null, NOW - 60_001]) {
    f.db.sqlite.prepare("UPDATE outcome_maintenance SET last_success_ms=?").run(lastSuccess);
    const response = await f.send(event);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "analytics_maintenance_unavailable", retryable: false,
    });
    assert.equal(row(f.db, "SELECT attempts FROM outcome_budget").attempts, ++attempts);
    assert.equal(count(f.db, "outcome_facts"), 0);
    assert.equal(count(f.db, "outcome_effects"), 0);
    assert.equal(count(f.db, "outcome_summary"), 0);
  }
  f.db.sqlite.exec("DROP TABLE outcome_maintenance");
  const unknown = await f.send(event);
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), { error: "outcome_unavailable", retryable: true });
  assert.equal(row(f.db, "SELECT attempts FROM outcome_budget").attempts, ++attempts);
  assert.equal(count(f.db, "outcome_facts"), 0);
});

test("confirmed facts, relational public references, effect claim, summary and validated legacy settlement are atomic", async t => {
  const f = await fixture(t);
  const event = commit(f.publication, 1, {
    outcome: "no_great", attemptCount: 2, legacySettlement: legacy("no_great_success", 2),
  });
  assert.equal((await f.send(event)).status, 200);
  assert.equal(count(f.db, "outcome_facts"), 1);
  assert.equal(count(f.db, "outcome_public_artifacts"), 1);
  assert.equal(count(f.db, "outcome_public_slots"), 1);
  assert.deepEqual(row(f.db, "SELECT outcome,attempt_count FROM outcome_results"), { outcome: "no_great", attempt_count: 2 });
  assert.deepEqual(row(f.db, "SELECT raw_admitted,attempt_applied,legacy_settled FROM outcome_effects"),
    { raw_admitted: 1, attempt_applied: 1, legacy_settled: 1 });
  assert.deepEqual(row(f.db, "SELECT reports,great_reports,no_great_reports,known_attempt_reports,attempts FROM outcome_summary"),
    { reports: 1, great_reports: 0, no_great_reports: 1, known_attempt_reports: 1, attempts: 2 });
  assert.deepEqual(row(f.db, "SELECT events,attempts,great_successes FROM stats_public_totals"),
    { events: 1, attempts: 2, great_successes: 0 });
  assert.deepEqual(f.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("lost acknowledgement, post-patch original retry and 14-day receipt cleanup never reset or duplicate permanent facts", async t => {
  const f = await fixture(t), original = commit(f.publication);
  const batch = f.db.batch.bind(f.db);
  let lost = false;
  f.db.batch = async statements => {
    const result = await batch(statements);
    if (!lost && statements.some(item => item.sql.includes("INSERT INTO outcome_effects"))) {
      lost = true; throw new Error("TEST_ONLY_LOST_ACK");
    }
    return result;
  };
  assert.deepEqual(await (await f.send(original)).json(), { ok: true, duplicate: true });
  assert.equal((await f.send(patch(original.reportId, 1, legacy()))).status, 200);
  f.db.now += 15 * 86_400_000;
  await f.store.cleanup(f.db.now, 100);
  await cleanupExpiredStatistics({ DB: f.db }, Math.floor(f.db.now / 1000));
  assert.equal(count(f.db, "outcome_controls"), 0); assert.equal(count(f.db, "outcome_receipts"), 0);
  assert.equal(count(f.db, "event_ids"), 0);
  f.calls.length = 0;
  assert.deepEqual(await (await f.send(original)).json(), { ok: true, duplicate: true });
  assert.deepEqual(f.calls.slice(0, 4), ["rate", "turnstile", "guard", "lookup"]);
  assert.deepEqual(row(f.db, "SELECT outcome,attempt_count FROM outcome_results"), { outcome: "great", attempt_count: 1 });
  assert.deepEqual(row(f.db, "SELECT reports,attempts,known_great_reports FROM outcome_summary"),
    { reports: 1, attempts: 1, known_great_reports: 1 });
  assert.deepEqual(row(f.db, "SELECT events,attempts,great_successes FROM stats_public_totals"),
    { events: 1, attempts: 1, great_successes: 1 });
  assert.equal((await f.send(commit(f.publication, 1, { waitRecommended: false }))).status, 409);
});

test("concurrent identical commits have one winner; conflicting report ID reuse is rejected", async t => {
  const f = await fixture(t), event = commit(f.publication);
  const results = await Promise.all([f.send(event), f.send(event)]);
  const bodies = await Promise.all(results.map(result => result.json()));
  assert.deepEqual(bodies.map(body => body.duplicate).sort(), [false, true]);
  assert.equal(count(f.db, "outcome_facts"), 1);
  assert.equal(row(f.db, "SELECT reports FROM outcome_summary").reports, 1);
  assert.equal((await f.send(commit(f.publication, 1, { holdings: { blue: 50, purple: 20, yellow: 10 } }))).status, 409);
});

test("fresh security failures cannot use permanent dedupe as an authentication bypass", async t => {
  const f = await fixture(t), event = commit(f.publication);
  await f.send(event); f.calls.length = 0;
  f.ports.verify = async () => { f.calls.push("turnstile"); throw new HttpError(403, "turnstile_failed", false); };
  assert.equal((await f.send(event)).status, 403);
  assert.deepEqual(f.calls, ["rate", "turnstile"]);
  assert.equal(row(f.db, "SELECT reports FROM outcome_summary").reports, 1);
});

test("settlement-only patches preserve unknown explicit attempts and settle the old denominator exactly once", async t => {
  const f = await fixture(t), original = commit(f.publication);
  await f.send(original);
  const settlement = patch(original.reportId, null, legacy("great_success", 2));
  assert.equal((await f.send(settlement)).status, 200);
  assert.equal(row(f.db, "SELECT attempt_count FROM outcome_results").attempt_count, null);
  assert.deepEqual(row(f.db, "SELECT known_attempt_reports,attempts,known_great_reports FROM outcome_summary"),
    { known_attempt_reports: 0, attempts: 0, known_great_reports: 0 });
  assert.deepEqual(row(f.db, "SELECT events,attempts,great_successes FROM stats_public_totals"),
    { events: 1, attempts: 2, great_successes: 1 });
  assert.deepEqual(await (await f.send(settlement)).json(), { ok: true, duplicate: true });
  assert.equal((await f.send(patch(original.reportId, 1))).status, 409);
  assert.equal((await f.send(patch(original.reportId, 2))).status, 200);
  assert.deepEqual(await (await f.send(patch(original.reportId, 2, legacy("great_success", 2)))).json(),
    { ok: true, duplicate: true });
  assert.equal(row(f.db, "SELECT patch_revision FROM outcome_effects").patch_revision, 2);
  const changed = legacy("great_success", 2);
  changed.start.grade = "SR"; changed.resultState.grade = "SR";
  assert.equal((await f.send(patch(original.reportId, 2, changed))).status, 409);
  assert.deepEqual(row(f.db, "SELECT events,attempts,great_successes FROM stats_public_totals"),
    { events: 1, attempts: 2, great_successes: 1 });
});

test("concurrent conflicting attempts cannot double-apply either summary or legacy settlement", async t => {
  const f = await fixture(t), event = commit(f.publication);
  await f.send(event);
  const requests = [patch(event.reportId, 1, legacy()), patch(event.reportId, 2, legacy("great_success", 2))];
  const results = await Promise.all(requests.map(value => f.send(value)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const accepted = requests[results.findIndex(result => result.status === 200)].data.attemptCount;
  assert.deepEqual(row(f.db, "SELECT reports,known_attempt_reports,attempts,known_great_reports FROM outcome_summary"),
    { reports: 1, known_attempt_reports: 1, attempts: accepted, known_great_reports: 1 });
  assert.deepEqual(row(f.db, "SELECT events,attempts,great_successes FROM stats_public_totals"),
    { events: 1, attempts: accepted, great_successes: 1 });
});

test("expired controls close new patch effects but never expire the original fact", async t => {
  const f = await fixture(t), event = commit(f.publication);
  await f.send(event); f.db.now += 86_400_000;
  assert.equal((await f.send(patch(event.reportId, 1, legacy()))).status, 409);
  assert.equal(count(f.db, "outcome_facts"), 1);
  assert.equal(row(f.db, "SELECT attempt_count FROM outcome_results").attempt_count, null);
  assert.equal(count(f.db, "event_aggregates_game_day"), 0);
});

test("failure after raw insertion rolls back facts, outcome, claim, reference copy and all summaries", async t => {
  const f = await fixture(t);
  f.db.sqlite.exec(`CREATE TRIGGER fail_summary BEFORE INSERT ON outcome_summary
    BEGIN SELECT RAISE(ABORT,'TEST_ONLY_ATOMIC_FAILURE'); END;`);
  assert.equal((await f.send(commit(f.publication, 1, { attemptCount: 1, legacySettlement: legacy() }))).status, 503);
  for (const table of ["outcome_facts", "outcome_results", "outcome_effects", "outcome_public_artifacts",
    "outcome_public_slots", "event_ids", "outcome_summary", "event_aggregates_game_day", "stats_public_totals"])
    assert.equal(count(f.db, table), 0, table);
});

test("legacy transition validation remains authoritative, not replaced by shape or coarse grouping", async t => {
  const f = await fixture(t);
  const invalid = legacy(); invalid.resultState = { grade: "R", level: 4, exp: 0 };
  const response = await f.send(commit(f.publication, 1, { attemptCount: 1, legacySettlement: invalid }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_success_result_state");
  assert.equal(count(f.db, "outcome_facts"), 0);
});

test("unavailable public projections remain unavailable with null quantities, not a fabricated zero", async t => {
  const f = await fixture(t);
  const normalized = { ...f.publication.normalized, projection: { status: "unavailable", reason: "coverage_incomplete" } };
  f.ports.authorize = () => prepareOutcomePublication(f.publication.publication, normalized, {
    maxPublicRows: 1000, maxPublicBytes: 1_000_000,
  });
  assert.equal((await f.send(commit(f.publication))).status, 200);
  assert.deepEqual(row(f.db, "SELECT projection_status,unavailable_reason,unit,blue_numerator,blue_denominator FROM outcome_public_slots"),
    { projection_status: "unavailable", unavailable_reason: "coverage_incomplete", unit: null, blue_numerator: null, blue_denominator: null });
});

test("the immutable historical public copy is signature-verified without reading or substituting the latest source", async t => {
  const f = await fixture(t);
  await f.send(commit(f.publication));
  const neverSource = { withSession() { throw new Error("LATEST_SOURCE_MUST_NOT_BE_READ"); } };
  const neverGuard = { withSession() { throw new Error("NO_FORECAST_SOURCE_ACCESS"); } };
  const copied = await resolveOutcomePublication(f.publication.publication.contentHash, f.db,
    neverSource, neverGuard, f.publication.trust, 1_000_000);
  assert.equal(copied.contentHash, f.publication.publication.contentHash);
  assert.throws(() => f.db.sqlite.exec("UPDATE outcome_public_artifacts SET candidate_json='{}'"), /immutable/);
  assert.throws(() => f.db.sqlite.exec("DELETE FROM outcome_public_artifacts"), /permanent/);
  const other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const key = Buffer.from(await crypto.subtle.exportKey("raw", other.publicKey)).toString("base64");
  await assert.rejects(resolveOutcomePublication(copied.contentHash, f.db, neverSource, neverGuard,
    { ...f.publication.trust, publicKeyBase64: key }, 1_000_000), /signature/);
});

test("no preconfirmation or WAIT-only event can enter the outcome-only store; cutover retires v3 admission", async t => {
  const f = await fixture(t);
  assert.equal((await f.send({ ...commit(f.publication), data: { ...commit(f.publication).data, chosenMethod: "wait" } })).status, 400);
  for (const config of [{ ...CONFIG, OUTCOME_FACTS_ENABLED: "false" }, { ...CONFIG, STATS_CAPABILITY_CUTOVER: "false" }])
    assert.equal((await f.send(commit(f.publication), config)).status, 404);
  const response = await handleDecisionAnalytics(new Request("https://unit.invalid/api/decision-events", { method: "POST" }),
    { DECISION_ANALYTICS_ENABLED: "true", STATS_CAPABILITY_CUTOVER: "true" },
    { respond: (body, status) => Response.json(body, { status }) });
  assert.equal(response.status, 410);
  assert.equal(count(f.db, "outcome_facts"), 0);
});

test("an existing legacy receipt cannot acquire a conflicting new permanent report claim", async t => {
  const f = await fixture(t);
  f.db.sqlite.prepare("INSERT INTO event_ids(id,created_at) VALUES(?,?)").run(id(1), Math.floor(NOW / 1000));
  assert.equal((await f.send(commit(f.publication))).status, 409);
  assert.equal(count(f.db, "outcome_effects"), 0);
  assert.equal(count(f.db, "outcome_facts"), 0);
});
