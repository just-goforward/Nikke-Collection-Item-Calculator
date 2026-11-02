import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  ACTIONS, ATTEMPTS, BANDS, DEDUPE_TTL_MS, EPISODE_TTL_MS, MAX_CONTRIBUTIONS,
  MAX_DAILY_CELLS, MAX_DAILY_CELLS_PER_PRODUCER, MAX_PRODUCERS, MAX_BATCH_STATEMENTS,
  STAGES, TERMINALS, canonicalDecisionEvent, parseDecisionEnvelope,
  DecisionAnalyticsError,
} from "../../shared/decisionAnalyticsV3.ts";
import { contributions, dayExpiry, jointVocabulary, planEvent, utcDay } from "../src/decision-analytics-model.ts";
import { analyticsConfig, handleDecisionAnalytics, parseProducers } from "../src/decision-analytics-handler.ts";
import { D1DecisionAnalyticsStore } from "../src/decision-analytics-store.ts";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const HASH = "a".repeat(64);
// Explicitly synthetic fixtures. Neither tuple is a real/approved public release.
const TEST_PRODUCER = { producerVersion: "TEST-ONLY-producer-a", producerCodeHash: "b".repeat(64) };
const TEST_PRODUCER_B = { producerVersion: "TEST-ONLY-producer-b", producerCodeHash: "c".repeat(64) };
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const env = {
  DECISION_ANALYTICS_ENABLED: "true", DECISION_ANALYTICS_SCHEMA_VERSION: "3",
  DECISION_ANALYTICS_PRODUCERS: JSON.stringify([TEST_PRODUCER, TEST_PRODUCER_B]),
  DECISION_ANALYTICS_DAILY_WRITE_ATTEMPTS: "100",
  DECISION_ANALYTICS_PUBLICATION_CONTENT_HASH: HASH,
  DECISION_ANALYTICS_MAX_MAINTENANCE_AGE_MS: "60000",
  DECISION_ANALYTICS_MAX_OVERDUE_MS: "1000", DECISION_ANALYTICS_MAX_BACKLOG_ROWS: "2",
};
const bands = { blue: "zero", purple: "one_to_nine", yellow: "ten_to_forty_nine" };
function wire(stage = "calculation", decision = 100) {
  const index = STAGES.indexOf(stage);
  const data = stage === "calculation"
    ? { ...TEST_PRODUCER, publicationContentHash: HASH, currentAction: "use_blue", waitRecommended: true, holdings: bands, expectedSupply: bands }
    : stage === "first_action" ? { action: "outcome_open" }
    : stage === "outcome_confirmation" ? { outcome: "success" }
    : stage === "attempt_self_report" ? { attempts: "two_to_four", outcomeEventId: id(decision + STAGES.indexOf("outcome_confirmation") + 1) }
    : stage === "terminal" ? { reason: "superseded" } : {};
  return { version: 3, kind: "decision_episode", decisionId: id(decision), eventId: id(decision + index + 1),
    ordinal: index + 1, stage, data, turnstileToken: "synthetic-security-token" };
}
function event(stage = "calculation", decision = 100) { return parseDecisionEnvelope(wire(stage, decision)).event; }
function request(payload = wire(), headers = {}) {
  return new Request("https://unit.invalid/api/decision-events", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload),
  });
}
class MemoryStore {
  episodes = new Map(); ids = new Map(); counters = new Map(); calls = [];
  attempts = 0; failCommit = false;
  maintenance = { lastSuccess: NOW, oldestOverdue: null, backlog: 0, capped: false };
  async deduped(key, now) { this.calls.push("dedupe"); return (this.ids.get(key) ?? 0) > now; }
  async episode(key) { this.calls.push("episode"); return this.episodes.get(key) ?? null; }
  async reserveBudget(_now, limit) { this.calls.push("budget"); if (this.attempts >= limit) return false; this.attempts++; return true; }
  async health() { this.calls.push("health"); return this.maintenance; }
  async commit(plan) {
    this.calls.push("commit");
    if (this.failCommit) throw new Error("synthetic driver details must not escape");
    const previous = this.episodes.get(plan.episode.decisionId);
    if ((previous?.revision ?? 0) !== plan.previousRevision || this.ids.has(plan.event.eventId)) return false;
    // Atomic fake model, not an SQL interpreter or D1-concurrency proof.
    const counters = new Map(this.counters);
    for (const item of plan.increments) {
      const key = `${plan.day}/${plan.episode.producer.producerVersion}/${plan.episode.producer.producerCodeHash}/${item.metric}/${item.bucket}`;
      counters.set(key, (counters.get(key) ?? 0) + 1);
    }
    this.episodes.set(plan.episode.decisionId, plan.episode);
    this.ids.set(plan.event.eventId, plan.now + DEDUPE_TTL_MS);
    this.counters = counters;
    return true;
  }
}
function ports(store = new MemoryStore()) {
  const calls = [];
  return { storeValue: store, calls, now: () => NOW, nonce: () => id(900),
    allowed: () => { calls.push("origin"); return true; },
    readPayload: async (req) => { calls.push("body"); return JSON.parse(await req.text()); },
    limit: async () => { calls.push("rate"); },
    verify: async () => { calls.push("turnstile"); },
    guard: async () => { calls.push("guard"); },
    store: () => { calls.push("store"); return store; },
    respond: (body, status) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } }),
  };
}

test("OFF and missing schema/config return before all security/body/store side effects", async () => {
  for (const config of [{}, { ...env, DECISION_ANALYTICS_ENABLED: "false" },
    { ...env, DECISION_ANALYTICS_SCHEMA_VERSION: undefined }, { ...env, DECISION_ANALYTICS_DAILY_WRITE_ATTEMPTS: undefined },
    { ...env, DECISION_ANALYTICS_MAX_OVERDUE_MS: undefined },
    { ...env, DECISION_ANALYTICS_PRODUCERS: undefined },
    { ...env, DECISION_ANALYTICS_PRODUCERS: "[]" },
    { ...env, DECISION_ANALYTICS_SCHEMA_VERSION: "2" }]) {
    const p = ports();
    const response = await handleDecisionAnalytics(request(), config, p);
    assert.ok([404, 503].includes(response.status));
    assert.deepEqual(p.calls, []); assert.deepEqual(p.storeValue.calls, []);
    assert.equal((await response.json()).retryable, false);
  }
});
test("strict registered family, random-shaped IDs, ordinals, closed nested dimensions", () => {
  for (const patch of [
    { version: 1 }, { version: 2 }, { kind: "kit_result" }, { eventId: id(100) }, { decisionId: "parent-derived-id" },
    { ordinal: 0 }, { ordinal: 2 }, { accountId: "forbidden" }, { calculatedAtMs: NOW },
    { data: { ...wire().data, exactStock: 1 } },
    { data: { ...wire().data, holdings: { ...bands, sourceHost: "forbidden" } } },
    { data: { ...wire().data, holdings: { ...bands, blue: "unknown_freeform" } } },
  ]) assert.throws(() => parseDecisionEnvelope({ ...wire(), ...patch }));
  assert.throws(() => parseDecisionEnvelope({ ...wire("terminal"), data: { reason: "account_context_changed" } }));
  assert.throws(() => parseDecisionEnvelope({ ...wire("attempt_self_report"), data: { attempts: null } }));
  assert.equal(parseDecisionEnvelope(wire()).event.kind, "decision_episode");
});
test("normalized payload excludes token and canonicalization ignores object order", () => {
  const a = parseDecisionEnvelope(wire()).event;
  assert.ok(!canonicalDecisionEvent(a).includes("synthetic-security-token"));
  assert.equal(canonicalDecisionEvent(a), canonicalDecisionEvent({ ...a, data: {
    expectedSupply: bands, holdings: bands, currentAction: "use_blue", waitRecommended: true, publicationContentHash: HASH,
    producerCodeHash: TEST_PRODUCER.producerCodeHash, producerVersion: TEST_PRODUCER.producerVersion,
  } }));
});
test("security/guard precede store; no raw arbitrary error escapes", async () => {
  const p = ports();
  const response = await handleDecisionAnalytics(request(), env, p);
  assert.equal(response.status, 200);
  assert.deepEqual(p.calls, ["origin", "rate", "body", "turnstile", "guard", "store"]);
  p.storeValue.failCommit = true;
  const failed = await handleDecisionAnalytics(request(wire("calculation", 200)), env, p);
  assert.deepEqual(await failed.json(), { error: "analytics_unavailable", retryable: true });
});
test("wrong origin/body/content identity fail without storage", async () => {
  const denied = ports(); denied.allowed = () => false;
  assert.equal((await handleDecisionAnalytics(request(), env, denied)).status, 403);
  const large = ports();
  assert.equal((await handleDecisionAnalytics(request(wire(), { "Content-Length": "4097" }), env, large)).status, 413);
  const wrong = ports();
  const payload = wire(); payload.data.publicationContentHash = "b".repeat(64);
  assert.equal((await handleDecisionAnalytics(request(payload), env, wrong)).status, 400);
  assert.deepEqual(wrong.storeValue.calls, []);
});
test("native limit, Turnstile and Guard failures preserve typed error and block store", async () => {
  for (const [port, status, code, retryable] of [
    ["limit", 429, "rate_limited", false],
    ["verify", 502, "turnstile_unavailable", true],
    ["guard", 503, "telemetry_budget_disabled", false],
  ]) {
    const p = ports(); p[port] = async () => { throw new DecisionAnalyticsError(status, code, retryable); };
    const response = await handleDecisionAnalytics(request(), env, p);
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: code, retryable });
    assert.deepEqual(p.storeValue.calls, []);
  }
});
test("falsely attested missing schema fails unavailable, never creates or falls back", async () => {
  const p = ports();
  p.storeValue.deduped = async () => { throw new Error("no such synthetic table"); };
  const response = await handleDecisionAnalytics(request(), env, p);
  assert.deepEqual(await response.json(), { error: "analytics_unavailable", retryable: true });
  assert.equal(p.storeValue.episodes.size, 0); assert.equal(p.storeValue.attempts, 0);
});
test("unknown parent creates no orphan, budget reservation or aggregate", async () => {
  const p = ports();
  const response = await handleDecisionAnalytics(request(wire("first_action")), env, p);
  assert.equal(response.status, 409); assert.equal((await response.json()).retryable, true);
  assert.equal(p.storeValue.episodes.size, 0); assert.equal(p.storeValue.counters.size, 0);
  assert.ok(!p.storeValue.calls.includes("budget"));
});
test("idempotent duplicate does not slide expiry, write budget or counters; conflicting replay rejected", async () => {
  const p = ports();
  await handleDecisionAnalytics(request(), env, p);
  const state = p.storeValue.episodes.get(id(100)); const count = p.storeValue.counters.size;
  assert.equal(state.expiresAt, NOW + EPISODE_TTL_MS);
  p.now = () => NOW + 1000;
  assert.deepEqual(await (await handleDecisionAnalytics(request(), env, p)).json(), { ok: true, duplicate: true });
  assert.equal(p.storeValue.attempts, 1); assert.equal(p.storeValue.counters.size, count);
  assert.equal(p.storeValue.episodes.get(id(100)).expiresAt, state.expiresAt);
  const conflict = wire(); conflict.data.currentAction = "use_purple";
  assert.equal((await handleDecisionAnalytics(request(conflict), env, p)).status, 409);
});
test("expiry fences transition and contributions even with cleanup blocked", async () => {
  const p = ports(); await handleDecisionAnalytics(request(), env, p);
  const state = p.storeValue.episodes.get(id(100));
  p.now = () => state.expiresAt;
  const response = await handleDecisionAnalytics(request(wire("first_action")), env, p);
  assert.equal(response.status, 410); assert.deepEqual(contributions(state, state.expiresAt), []);
  assert.equal(p.storeValue.episodes.get(id(100)).revision, 1);
  assert.equal(p.storeValue.attempts, 1);
});
test("independent event-ID horizon is opaque after linkage expiry, never reconstructs parent", async () => {
  const p = ports(); await handleDecisionAnalytics(request(), env, p);
  p.storeValue.episodes.clear(); p.now = () => NOW + EPISODE_TTL_MS;
  assert.deepEqual(await (await handleDecisionAnalytics(request(), env, p)).json(), { ok: true, duplicate: true });
  assert.equal(p.storeValue.episodes.size, 0);
  p.now = () => NOW + DEDUPE_TTL_MS + 1;
  assert.equal(await p.storeValue.deduped(id(101), p.now()), false);
  // No eternal replay proof: after deletion of both independent histories, old initial
  // event is indistinguishable. Real stale PK cleanup is separately engine-gated.
});
test("unknown/stale/over-lag/capped maintenance blocks new admission without relaxing guard", async () => {
  for (const health of [
    { lastSuccess: null, oldestOverdue: null, backlog: 0, capped: false },
    { lastSuccess: NOW - 60001, oldestOverdue: null, backlog: 0, capped: false },
    { lastSuccess: NOW, oldestOverdue: NOW - 1001, backlog: 1, capped: false },
    { lastSuccess: NOW, oldestOverdue: null, backlog: 3, capped: false },
    { lastSuccess: NOW, oldestOverdue: null, backlog: 0, capped: true },
  ]) {
    const p = ports(); p.storeValue.maintenance = health;
    const response = await handleDecisionAnalytics(request(), env, p);
    assert.deepEqual(await response.json(), { error: "analytics_maintenance_unavailable", retryable: false });
    assert.equal(p.storeValue.episodes.size, 0); assert.ok(p.calls.includes("guard"));
  }
});
test("explicit attempt cap enforced; config is not an invented production volume", async () => {
  const p = ports();
  await handleDecisionAnalytics(request(), { ...env, DECISION_ANALYTICS_DAILY_WRITE_ATTEMPTS: "1" }, p);
  const response = await handleDecisionAnalytics(request(wire("calculation", 200)),
    { ...env, DECISION_ANALYTICS_DAILY_WRITE_ATTEMPTS: "1" }, p);
  assert.equal(response.status, 429); assert.equal(p.storeValue.episodes.size, 1);
  assert.equal(analyticsConfig({ ...env, DECISION_ANALYTICS_MAX_BACKLOG_ROWS: "401" }), null);
});
test("all follow-up receipt permutations converge without double counting; first action distinct from outcome/attempt", () => {
  function* permutations(xs) {
    if (!xs.length) yield [];
    for (let i = 0; i < xs.length; i++)
      for (const tail of permutations(xs.filter((_, j) => i !== j))) yield [xs[i], ...tail];
  }
  let expected;
  for (const order of permutations(STAGES.slice(1))) {
    let state = planEvent(null, event(), NOW).episode;
    const totals = new Map(contributions(state, NOW).map((x) => [`${x.metric}/${x.bucket}`, 1]));
    for (const stage of order) {
      const plan = planEvent(state, event(stage), NOW + 1000);
      for (const x of plan.increments) totals.set(`${x.metric}/${x.bucket}`, (totals.get(`${x.metric}/${x.bucket}`) ?? 0) + 1);
      state = plan.episode;
    }
    const actual = [...totals].sort();
    expected ??= actual; assert.deepEqual(actual, expected);
    assert.equal(actual.length, MAX_CONTRIBUTIONS);
    assert.ok(actual.every(([, count]) => count === 1));
    assert.equal(state.expiresAt, NOW + EPISODE_TTL_MS);
  }
});
test("retirement closes later callbacks but accepts already-captured earlier delivery", () => {
  let state = planEvent(null, event(), NOW).episode;
  const terminal = event("terminal"); terminal.ordinal = 5;
  state = planEvent(state, terminal, NOW).episode;
  assert.doesNotThrow(() => planEvent(state, event("first_action"), NOW));
  assert.throws(() => planEvent(state, event("attempt_self_report"), NOW), /decision_closed/);
  const first = event("first_action"); first.ordinal = 5;
  assert.throws(() => planEvent(state, first, NOW), /decision_order_conflict/);
});
test("UTC cohort and immutable90d boundary do not slide on next-day follow-up", () => {
  const created = Date.parse("2026-11-01T23:59:00Z");
  const first = planEvent(null, event(), created);
  const next = planEvent(first.episode, event("first_action"), created + 120000);
  assert.equal(next.day, "2026-11-01"); assert.equal(next.aggregateExpiry, first.aggregateExpiry);
  assert.equal(next.aggregateExpiry, Date.parse("2027-01-30T00:00:00Z"));
  assert.equal(dayExpiry(utcDay(created)), next.aggregateExpiry);
});
test("closed joint+marginal universe has139 cells/cohort and278 per fixed two-producer configuration only", () => {
  const declared = STAGES.length + BANDS.length * 6 + ACTIONS.length + TERMINALS.length + 27 + 36 + 24;
  assert.equal(declared, MAX_DAILY_CELLS_PER_PRODUCER);
  assert.equal(declared * MAX_PRODUCERS, MAX_DAILY_CELLS);
});
test("CAS loser and cross-event collision fake commits have no partial state/counter changes", async () => {
  const store = new MemoryStore();
  const a = planEvent(null, event(), NOW);
  assert.equal(await store.commit(a), true);
  const snapshot = JSON.stringify([...store.counters]);
  assert.equal(await store.commit(a), false);
  assert.equal(JSON.stringify([...store.counters]), snapshot);
});

class CaptureDatabase {
  statements = []; batches = [];
  prepare(sql) {
    const item = { sql, args: [], bind(...args) { this.args = args; return this; }, async first() { return null; } };
    this.statements.push(item); return item;
  }
  async batch(statements) { this.batches.push(statements); return statements.map((_, i) => ({ results: i === statements.length - 1 ? [{ winner: 1 }] : [] })); }
}
test("SQL adapter uses conditional atomic batch and ID-only dedupe, without executing SQL", async () => {
  const db = new CaptureDatabase(); const store = new D1DecisionAnalyticsStore(db);
  const plan = planEvent(null, event(), NOW);
  assert.equal(await store.commit(plan, id(900)), true);
  const statements = db.batches[0];
  assert.ok(statements.length <= MAX_BATCH_STATEMENTS);
  const dedupe = statements.find((s) => s.sql.startsWith("INSERT INTO decision_analytics_dedupe"));
  assert.match(dedupe.sql, /CASE WHEN expires_at/); assert.match(dedupe.sql, /ELSE NULL/);
  assert.match(dedupe.sql, /\(event_id,first_received_at,expires_at\)/);
  assert.match(statements[0].sql, /revision=\?/);
  assert.ok(statements.filter((s) => s.sql.includes("INSERT INTO decision_analytics_daily"))
    .every((s) => !s.sql.includes("expires_at=excluded")));
});
test("new cleanup fixed400-row/five-statement pass and indexed capped ID-free health; legacy untouched", async () => {
  const db = new CaptureDatabase(); const store = new D1DecisionAnalyticsStore(db);
  await store.cleanup(NOW);
  assert.equal(db.batches.length, 1); assert.equal(db.batches[0].length, 5);
  assert.equal(db.batches[0].filter((s) => s.sql.startsWith("DELETE ")).length, 4);
  assert.ok(db.batches[0].slice(0, 4).every((s) => /ORDER BY expires_at LIMIT 100/.test(s.sql)));
  await store.health(NOW);
  const health = db.statements.at(-1).sql;
  assert.equal((health.match(/LIMIT 101/g) ?? []).length, 4);
  assert.ok(!health.includes("state_json"));
});
test("unexecuted proposal dedupe has no linkage/hash/dimensions; expiry indexes exist", () => {
  const sql = readFileSync(new URL("../decision-analytics/0001_decision_analytics_v3.proposed.sql", import.meta.url), "utf8");
  const dedupe = sql.split("CREATE TABLE decision_analytics_dedupe (")[1].split(");")[0];
  assert.ok(!/decision_id|payload|hash|stage|token/.test(dedupe));
  assert.equal((sql.match(/CREATE INDEX .*_expiry/g) ?? []).length, 4);
  assert.match(sql, /event_id TEXT PRIMARY KEY NOT NULL/);
  assert.match(sql, /last_success_ms INTEGER/);
});
test("producer allowlist rejects empty/malformed/over-two/duplicate-version configurations before side effects", async () => {
  for (const configured of [
    undefined, "[]", "null", "{bad",
    JSON.stringify([TEST_PRODUCER, TEST_PRODUCER]),
    JSON.stringify([TEST_PRODUCER, { ...TEST_PRODUCER, producerCodeHash: TEST_PRODUCER_B.producerCodeHash }]),
    JSON.stringify([TEST_PRODUCER, TEST_PRODUCER_B, { producerVersion: "TEST-ONLY-third", producerCodeHash: "d".repeat(64) }]),
    JSON.stringify([{ ...TEST_PRODUCER, producerCodeHash: "unbounded-freeform" }]),
    JSON.stringify([{ ...TEST_PRODUCER, accountId: "forbidden" }]),
  ]) {
    const p = ports();
    const response = await handleDecisionAnalytics(request(), { ...env, DECISION_ANALYTICS_PRODUCERS: configured }, p);
    assert.deepEqual(await response.json(), { error: "analytics_not_ready", retryable: false });
    assert.deepEqual(p.calls, []); assert.deepEqual(p.storeValue.calls, []);
  }
});
test("configured tuples are frozen and every version maps unambiguously to one public hash", () => {
  const tuples = parseProducers(env.DECISION_ANALYTICS_PRODUCERS);
  assert.equal(tuples.length, 2); assert.ok(Object.isFrozen(tuples));
  assert.ok(tuples.every(Object.isFrozen));
  assert.throws(() => { tuples[0].producerCodeHash = "d".repeat(64); }, TypeError);
});
test("unknown producer or mismatched version/hash is rejected before security provider/storage", async () => {
  for (const producer of [
    { ...TEST_PRODUCER, producerVersion: "TEST-ONLY-unknown" },
    { ...TEST_PRODUCER, producerCodeHash: TEST_PRODUCER_B.producerCodeHash },
  ]) {
    const p = ports(); const payload = wire(); Object.assign(payload.data, producer);
    const response = await handleDecisionAnalytics(request(payload), env, p);
    assert.deepEqual(await response.json(), { error: "unsupported_producer", retryable: false });
    assert.ok(!p.calls.includes("turnstile")); assert.deepEqual(p.storeValue.calls, []);
  }
});
test("producer context is calculation-only and missing binding cannot masquerade as current bundle", () => {
  const missing = wire(); delete missing.data.producerCodeHash;
  assert.throws(() => parseDecisionEnvelope(missing));
  const extra = wire("first_action"); extra.data.producerVersion = TEST_PRODUCER.producerVersion;
  assert.throws(() => parseDecisionEnvelope(extra));
});
test("same forecast with two explicitly TEST-ONLY algorithm releases remains separate", async () => {
  const p = ports();
  await handleDecisionAnalytics(request(), env, p);
  const b = wire("calculation", 200); Object.assign(b.data, TEST_PRODUCER_B);
  await handleDecisionAnalytics(request(b), env, p);
  assert.equal(p.storeValue.episodes.size, 2);
  assert.deepEqual(p.storeValue.episodes.get(id(100)).producer, TEST_PRODUCER);
  assert.deepEqual(p.storeValue.episodes.get(id(200)).producer, TEST_PRODUCER_B);
  assert.equal(p.storeValue.counters.size, 16);
  assert.ok([...p.storeValue.counters.values()].every((count) => count === 1));
});
test("followups inherit pinned tuple; changed configuration rejects rather than relabels it", async () => {
  const p = ports(); await handleDecisionAnalytics(request(), env, p);
  const changed = { ...env, DECISION_ANALYTICS_PRODUCERS: JSON.stringify([
    { ...TEST_PRODUCER, producerCodeHash: TEST_PRODUCER_B.producerCodeHash },
  ]) };
  const response = await handleDecisionAnalytics(request(wire("first_action")), changed, p);
  assert.deepEqual(await response.json(), { error: "decision_producer_conflict", retryable: false });
  assert.equal(p.storeValue.episodes.get(id(100)).revision, 1);
  assert.deepEqual(p.storeValue.episodes.get(id(100)).producer, TEST_PRODUCER);
  await handleDecisionAnalytics(request(wire("first_action")), env, p);
  assert.deepEqual(p.storeValue.episodes.get(id(100)).producer, TEST_PRODUCER);
});
test("SQL counter keys and episode CAS include pinned version/hash, never a current-config relabel", async () => {
  const db = new CaptureDatabase(); const store = new D1DecisionAnalyticsStore(db);
  await store.commit(planEvent(null, event(), NOW), id(900));
  const statements = db.batches[0];
  const episode = statements[0];
  assert.match(episode.sql, /decision_analytics_episodes\.producer_version=\?/);
  assert.match(episode.sql, /decision_analytics_episodes\.producer_code_hash=\?/);
  const counters = statements.filter((s) => s.sql.includes("INSERT INTO decision_analytics_daily"));
  assert.ok(counters.every((s) => s.sql.includes("ON CONFLICT(day,producer_version,producer_code_hash,metric,bucket)")));
  assert.ok(counters.every((s) => s.args[1] === TEST_PRODUCER.producerVersion && s.args[2] === TEST_PRODUCER.producerCodeHash));
});
const has = (state, metric, bucket) => contributions(state, NOW).some((x) => x.metric === metric && x.bucket === bucket);
function initial(data = {}) {
  const value = wire(); Object.assign(value.data, data);
  return planEvent(null, parseDecisionEnvelope(value).event, NOW).episode;
}
function append(state, stage, patch = {}) {
  const value = event(stage); Object.assign(value, patch);
  return planEvent(state, value, NOW).episode;
}
test("Current and WAIT coexist independently; WAIT never replaces Current action", () => {
  const both = initial();
  assert.equal(both.slots.calculation.data.currentAction, "use_blue");
  assert.equal(both.slots.calculation.data.waitRecommended, true);
  assert.ok(has(both, "joint_basis", "use_blue|1|all"));
  assert.ok(!has(both, "joint_basis", "use_blue|0|all"));
  const noWait = initial({ waitRecommended: false });
  assert.ok(has(noWait, "joint_basis", "use_blue|0|all"));
  for (const data of [{ currentAction: "wait" }, { waitRecommended: 1 }, { waitDays: 7 },
    { recommendation: "wait" }, { sourceHash: HASH }]) {
    const value = wire(); Object.assign(value.data, data);
    assert.throws(() => parseDecisionEnvelope(value));
  }
});
test("Current presentation is not WAIT presentation; independent before-outcome subsets", () => {
  let state = append(initial(), "current_presented");
  state = append(state, "outcome_confirmation");
  assert.ok(has(state, "joint_basis", "use_blue|1|current"));
  assert.ok(!has(state, "joint_basis", "use_blue|1|wait"));
  assert.ok(has(state, "joint_outcome", "use_blue|1|current|success"));
  assert.ok(!has(state, "joint_outcome", "use_blue|1|wait|success"));
  const before = new Set(contributions(state, NOW).map((x) => `${x.metric}/${x.bucket}`));
  state = append(state, "wait_presented"); // late receipt, earlier capture ordinal3<outcome5
  assert.ok(has(state, "joint_outcome", "use_blue|1|both|success"));
  assert.ok(has(state, "joint_basis", "use_blue|1|both"));
  const after = new Set(contributions(state, NOW).map((x) => `${x.metric}/${x.bucket}`));
  assert.ok([...before].every((key) => after.has(key))); // add evidence, never relabel/decrement
});
test("WAIT shown after outcome does not fabricate exposure before accepted success", () => {
  let state = append(append(initial(), "current_presented"), "outcome_confirmation");
  state = append(state, "wait_presented", { ordinal: 6 });
  assert.ok(has(state, "joint_basis", "use_blue|1|both"));
  assert.ok(has(state, "joint_outcome", "use_blue|1|current|success"));
  assert.ok(!has(state, "joint_outcome", "use_blue|1|wait|success"));
  assert.ok(!has(state, "joint_outcome", "use_blue|1|both|success"));
});
test("all accepted explicit success application branches count great-success report without attempt claim", () => {
  // Static caller evidence: known-one, modal (including later null) and stock-edit branches
  // all return outcome:success. This tests their common wire receipt, not React execution.
  for (const sourceBranch of ["known-one-inferred", "modal-then-null", "stock-edit-needed"]) {
    const state = append(initial(), "outcome_confirmation");
    assert.ok(has(state, "joint_outcome", "use_blue|1|all|success"), sourceBranch);
    assert.ok(!contributions(state, NOW).some((x) => x.metric === "joint_attempt"));
  }
  const explicitOne = event("attempt_self_report");
  explicitOne.data.attempts = "one";
  assert.ok(has(planEvent(append(initial(), "outcome_confirmation"), explicitOne, NOW).episode,
    "joint_attempt", "use_blue|1|one")); // actual explicit modal1 remains valid
});
test("accepted fail is an observed outcome report, not great-success or evidence from silence", () => {
  const outcome = event("outcome_confirmation"); outcome.data.outcome = "fail";
  const state = planEvent(initial(), outcome, NOW).episode;
  assert.ok(has(state, "joint_outcome", "use_blue|1|all|fail"));
  assert.ok(!has(state, "joint_outcome", "use_blue|1|all|success"));
  assert.throws(() => planEvent(state, event("attempt_self_report"), NOW), /attempt_outcome_mismatch/);
  const absent = contributions(initial(), NOW);
  assert.ok(!absent.some((x) => x.metric === "joint_outcome" || x.metric === "joint_attempt"));
  assert.ok(!absent.some((x) => /unobserved|refusal|no_action|no_enhancement/.test(x.bucket)));
});
test("explicit attempt requires matched same-run success receipt; inferred/null/cancel is not a count", () => {
  const outcome = event("outcome_confirmation");
  let state = planEvent(initial(), outcome, NOW).episode;
  const wrong = event("attempt_self_report"); wrong.data.outcomeEventId = id(999);
  assert.throws(() => planEvent(state, wrong, NOW), /attempt_outcome_mismatch/);
  const correct = event("attempt_self_report");
  state = planEvent(state, correct, NOW).episode;
  assert.ok(has(state, "joint_attempt", "use_blue|1|two_to_four"));
  for (const attempts of [null, "zero", "inferred_one", "cancelled"]) {
    const value = wire("attempt_self_report"); value.data.attempts = attempts;
    assert.throws(() => parseDecisionEnvelope(value));
  }
  assert.throws(() => parseDecisionEnvelope({ ...wire("outcome_confirmation"), data: {} }));
});
test("orphan attempt inside live parent cannot manufacture success before actual matching outcome", () => {
  let state = append(initial(), "attempt_self_report");
  assert.ok(!contributions(state, NOW).some((x) => x.metric === "joint_attempt" || x.metric === "joint_outcome"));
  state = append(state, "outcome_confirmation");
  assert.ok(has(state, "joint_attempt", "use_blue|1|two_to_four"));
  const badAttempt = event("attempt_self_report"); badAttempt.data.outcomeEventId = id(999);
  let bad = planEvent(initial(), badAttempt, NOW).episode;
  bad = append(bad, "outcome_confirmation");
  assert.ok(has(bad, "joint_outcome", "use_blue|1|all|success"));
  assert.ok(!contributions(bad, NOW).some((x) => x.metric === "joint_attempt"));
});
test("invalid dimension/presentation/outcome combinations do not create false joint data", () => {
  assert.throws(() => append(initial({ waitRecommended: false }), "wait_presented"), /wait_not_recommended/);
  assert.throws(() => append(initial({ currentAction: "none" }), "current_presented"), /current_not_recommended/);
  assert.throws(() => append(initial({ currentAction: "preserve" }), "outcome_confirmation"), /outcome_without_current_action/);
  assert.ok(has(initial({ currentAction: "preserve" }), "joint_basis", "preserve|1|all"));
});
test("ID-free joint evidence survives erasure of episode state without creating a final no-action row", async () => {
  const p = ports();
  for (const stage of ["calculation", "current_presented", "wait_presented", "outcome_confirmation"]) {
    assert.equal((await handleDecisionAnalytics(request(wire(stage)), env, p)).status, 200);
  }
  p.storeValue.episodes.clear();
  const counts = [...p.storeValue.counters];
  assert.ok(counts.some(([key, count]) => key.endsWith("/joint_outcome/use_blue|1|both|success") && count === 1));
  assert.ok(counts.some(([key, count]) => key.endsWith("/joint_basis/use_blue|1|all") && count === 1));
  assert.ok(!counts.some(([key]) => /refusal|no_action|unobserved/.test(key)));
});
test("proposed SQL exact joint vocabulary is closed at27 bases/36 outcomes/24 explicit-attempt cells", () => {
  const sql = readFileSync(new URL("../decision-analytics/0001_decision_analytics_v3.proposed.sql", import.meta.url), "utf8");
  const vocabulary = jointVocabulary();
  for (const [metric, expected] of [["joint_basis", 27], ["joint_outcome", 36], ["joint_attempt", 24]]) {
    const match = sql.match(new RegExp(`metric='${metric}' AND bucket IN\\(([\\s\\S]*?)\\)\\)`));
    assert.ok(match);
    const actual = [...match[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.equal(new Set(actual).size, expected);
    assert.deepEqual([...new Set(actual)].sort(), vocabulary.filter((x) => x.metric === metric).map((x) => x.bucket).sort());
  }
  assert.match(sql, /revision BETWEEN 1 AND 7/);
  assert.ok(!sql.includes("'recommendation'"));
});
