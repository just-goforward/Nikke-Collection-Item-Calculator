import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  applyForecastD1Migrations,
  discoverForecastMigrations,
} from "./apply-forecast-d1-migrations.ts";

// The injected transport never spawns Wrangler. Each file has an explicit local
// SQLite transaction; this is NOT evidence of hosted D1/client-failure atomicity.
const root = process.env.MIGRATION_SOURCE_ROOT ?? resolve(import.meta.dirname, "..");
const migrations = discoverForecastMigrations(resolve(root, "forecast-collector/migrations"));
const source = (version) => readFileSync(migrations.find((m) => m.version === version).file, "utf8");
const historicalDDL = readFileSync(
  resolve(import.meta.dirname, "fixtures/forecast-preservation-historical-core.sql"), "utf8",
);
const options = { environment: "production", local: true, allowForecastV2: true };
const h = (text) => createHash("sha256").update(text).digest("hex");
const at = "2020-02-03T04:05:06.789Z";
const later = "2020-02-04T04:05:06.789Z";
const reviewId = (n) => `mr-${String(n).padStart(32, "0")}`;
const plain = (value) => JSON.parse(JSON.stringify(value));
const rows = (db, sql) => plain(db.prepare(sql).all());
const tableNames = (db) => rows(db,
  "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
).map((r) => r.name);
const ordered = (values) => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));

console.log(JSON.stringify({
  model: "node:sqlite :memory:, foreign_keys=ON, BEGIN IMMEDIATE/file, rollback on any error",
  runtime: { node: process.version, sqlite: process.versions.sqlite, execPath: process.execPath },
  checksums: Object.fromEntries([
    "scripts/apply-forecast-d1-migrations.ts", "forecast-collector/schema.sql",
    "forecast-collector/preflight-0011.sql", "package-lock.json",
    ...migrations.map((m) => m.file),
  ].map((path) => [path, h(readFileSync(resolve(root, path)))])),
}));

function insert(db, table, values) {
  const names = Object.keys(values);
  db.prepare(`INSERT INTO "${table}"(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`)
    .run(...Object.values(values));
}

function snapshot(db) {
  return {
    catalog: rows(db,
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
    ),
    tables: Object.fromEntries(tableNames(db).map((name) => [name, {
      columns: rows(db, `PRAGMA table_info("${name}")`),
      foreignKeys: rows(db, `PRAGMA foreign_key_list("${name}")`),
      indexes: ordered(rows(db, `PRAGMA index_list("${name}")`).map(({ seq, ...r }) => ({
        ...r, columns: rows(db, `PRAGMA index_info("${r.name}")`),
      }))),
      rows: ordered(rows(db, `SELECT * FROM "${name}"`)),
    }])),
  };
}

function integrity(db) {
  assert.deepEqual(rows(db, "PRAGMA foreign_key_check"), []);
  assert.deepEqual(rows(db, "PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
}

function atomic(db, sql, failureMarker) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (failureMarker !== undefined) {
      const index = sql.indexOf(failureMarker);
      assert.ok(index >= 0 && sql.indexOf(failureMarker, index + 1) < 0, "unique failure boundary");
      db.exec(sql.slice(0, index));
      throw new Error("preservation_injected_failure");
    }
    db.exec(sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function preserve(db, before, version) {
  for (const [table, original] of Object.entries(before.tables)) {
    if (table === "schema_migrations") continue;
    const expected = structuredClone(original.rows);
    if (version === 25 && table === "forecast_ops_alerts") {
      for (const row of expected) {
        const context = JSON.parse(row.context_json);
        if (row.alert_key.startsWith("naver-boundary:") && context.pageSize == null) {
          context.pageSize = 10;
          row.context_json = JSON.stringify(context);
        }
      }
    }
    const columns = original.columns.map((c) => c.name);
    const actual = rows(db, `SELECT ${columns.map((c) => `"${c}"`).join(",")} FROM "${table}"`);
    assert.deepEqual(ordered(actual), ordered(expected), `migration ${version}: retained ${table}`);
    const afterColumns = rows(db, `PRAGMA table_info("${table}")`);
    assert.deepEqual(afterColumns.slice(0, original.columns.length), original.columns,
      `migration ${version}: positional column count/order ${table}`);
    assert.deepEqual(rows(db, `PRAGMA foreign_key_list("${table}")`), original.foreignKeys,
      `migration ${version}: FK ${table}`);
    const after = snapshotTableIndexes(db, table);
    for (const index of original.indexes)
      assert.ok(after.some((i) => JSON.stringify(i) === JSON.stringify(index)),
        `migration ${version}: retained index ${index.name}`);
  }
  const afterTriggers = new Set(rows(db,
    "SELECT name FROM sqlite_schema WHERE type='trigger'",
  ).map((r) => r.name));
  for (const trigger of before.catalog.filter((r) => r.type === "trigger"))
    assert.ok(afterTriggers.has(trigger.name), `retained trigger ${trigger.name}`);
  integrity(db);
}

function snapshotTableIndexes(db, table) {
  return ordered(rows(db, `PRAGMA index_list("${table}")`).map(({ seq, ...r }) => ({
    ...r, columns: rows(db, `PRAGMA index_info("${r.name}")`),
  })));
}

function fixtureDDL(db, through, bootstrap = false) {
  db.exec("PRAGMA foreign_keys=ON");
  if (bootstrap) db.exec(readFileSync(resolve(root, "forecast-collector/schema.sql"), "utf8"));
  else {
    db.exec(historicalDDL);
    for (const version of [3, 7, 8, 9, 10]) atomic(db, source(version));
    if (through > 10) atomic(db, source(5));
  }
  for (const migration of migrations) {
    if (migration.version > through) break;
    if (migration.version <= (bootstrap ? 21 : 10) || [4, 6].includes(migration.version)) continue;
    atomic(db, source(migration.version));
  }
}

function historicalSeed(db, seed) {
  // Historical snapshots may no longer satisfy today's workflow predicates.
  // Load synthetic historical rows before installing the exact real triggers;
  // never invoke an activation trigger to reconstruct history.
  const triggers = rows(db, "SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name");
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
  seed();
  for (const { sql } of triggers) db.exec(sql);
}

function seedCommon(db) {
  insert(db, "collector_runs", {
    id: 42, deployment_sha: "legacy-한글", source: "collector", status: "completed",
    started_at: at, finished_at: later, error_code: null, next_retry_at: null, item_count: 2,
  });
  for (const item of ["100", "200"]) {
    insert(db, "source_items", {
      source: "naver-board-56", item_id: item, url: `https://fixture.invalid/${item}`,
      title: `공고 ${item} 🌙`, excerpt: "retained\r\né e\u0301 日本語",
      published_at: at, content_hash: h(item), structured: 0, official: 1,
      first_seen_at: at, last_seen_at: later,
    });
    insert(db, "source_queue", {
      source: "naver-board-56", item_id: item, url: `https://fixture.invalid/${item}`,
      title: `검토 ${item}`, published_at: at, official: 1,
      status: item === "100" ? "manual_review" : "processed",
      attempts: 3, review_generation: item === "100" ? 7 : 0, error_code: null,
      first_seen_at: at, updated_at: later,
    });
  }
  insert(db, "source_watermarks", {
    source: "naver-board-56", item_id: "200", published_at: at, content_hash: h("200"), updated_at: later,
  });
  insert(db, "source_poll_state", {
    source: "naver-board-56", committed_item_id: "200", committed_published_at: at,
    scan_head_item_id: null, scan_head_published_at: null, next_offset: 19, updated_at: later,
  });
  insert(db, "schedule_events", {
    event_id: "event-legacy", event_type: "solo", source: "naver-board-56", source_item_id: "100",
    starts_at: null, ends_at: later, schedule_status: "confirmed", manual_review: 0,
    reason: "오래된 확정 근거", observed_at: at,
  });
  for (const [n, state, generation] of [[1, "pending", 7], [2, "expired", 6], [3, "resolved", 5]]) {
    insert(db, "source_manual_reviews", {
      review_id: reviewId(n), source: "naver-board-56", item_id: "100", generation, state,
      decision: state === "resolved" ? "ignore" : null,
      actor: state === "resolved" ? "사용자" : null, reason: state === "resolved" ? "이력" : null,
      request_id: state === "resolved" ? `mrq-${"3".repeat(32)}` : null,
      request_payload_hash: state === "resolved" ? h("request") : null,
      event_payload_hash: null, created_at: at, expires_at: later,
      resolved_at: state === "pending" ? null : later,
    });
  }
  for (const [key, context] of [
    ["naver-boundary:missing", '{"설명":"유니코드","z":null}'],
    ["naver-boundary:null", '{"pageSize":null}'],
    ["naver-boundary:existing", '{"pageSize":5,"공백":"  "}'],
    ["other:unchanged", '{"pageSize":null}'],
  ]) insert(db, "forecast_ops_alerts", {
    alert_key: key, environment: "production", severity: "warning", component: "fixture",
    error_code: "fixture", state: "resolved", context_json: context,
    first_seen_at: at, last_seen_at: later, discord_message_id: "123456789",
  });
  for (const version of [1, 2]) seedCandidate(db, `legacy-${version}`, version, "superseded");
}

function seedCandidate(db, id, version, state = "crosschecked") {
  const payload = JSON.stringify({
    candidateId: id, forecastId: "forecast-한글", rulesVersion: `schedule-kit-v${version}`,
    payloadVersion: version + 1, certifiedSnapshot: { version: `certified-daily-v${version}` },
    opaque: "é e\u0301 🌙\r\n", nullable: null,
  });
  insert(db, "forecast_candidates", {
    candidate_id: id, forecast_id: "forecast-한글", schedule_event_id: "event-legacy",
    game_day: `2020-${String(version).padStart(2, "0")}-${id.includes("old") ? "02" : "01"}`,
    revision: 1, source_status: "crosschecked", state,
    payload_json: payload, payload_hash: h(payload), created_at: at, updated_at: later,
  });
  insert(db, "candidate_sources", {
    candidate_id: id, source: "naver-board-56", source_item_id: "100",
  });
  return { payload, hash: h(payload) };
}

function seedRuntime(db, through) {
  for (const id of ["v3-active", "v3-old"]) {
    const candidate = seedCandidate(db, id, 3, id.endsWith("old") ? "superseded" : "approved");
    insert(db, "forecast_runtime_versions", {
      candidate_id: id, payload_hash: candidate.hash, rules_version: "schedule-kit-v3",
      payload_version: 4, snapshot_version: "certified-daily-v3",
      payload_bytes: Buffer.byteLength(candidate.payload), sealed_at: 2,
    });
  }
  const activeHash = rows(db,
    "SELECT payload_hash FROM forecast_candidates WHERE candidate_id='v3-active'",
  )[0].payload_hash;
  const review = "r".repeat(32);
  insert(db, "forecast_runtime_reviews", {
    review_id: review, review_key: "expired-historical-검토", environment: "production",
    action: "approve", candidate_id: "v3-active", payload_hash: activeHash,
    expected_sequence: 6, previous_candidate_id: null, expires_at: 100, created_at: 1,
  });
  insert(db, "forecast_runtime_commands", {
    interaction_id: "historical-op", review_id: review, request_hash: h("command"), actor_id: "actor",
    state: "applied", attempts: 4, result_sequence: 7, error_code: null, created_at: 2, updated_at: 3,
  });
  const pointer = JSON.stringify({ statement: {
    domain: "nikke.forecast.pointer.v1", environment: "production", sequence: 7,
    candidateId: "v3-active", contentHash: activeHash, mode: "active",
    operationId: "historical-op", issuedAt: 3, keyId: "fixture-key",
  }, signature: "S".repeat(88), extra: "서명 바이트" });
  insert(db, "forecast_runtime_approvals", {
    candidate_id: "v3-active", interaction_id: "historical-op", environment: "production",
    payload_hash: activeHash, key_id: "fixture-key", artifact_signature: "S".repeat(88),
    actor_id: "actor", approved_at: 3,
  });
  insert(db, "forecast_runtime_active", {
    singleton: 1, environment: "production", sequence: 7, candidate_id: "v3-active",
    operation_id: "historical-op", signed_pointer_json: pointer,
  });
  insert(db, "forecast_runtime_activation_history", {
    operation_id: "historical-op", review_id: review, environment: "production", action: "approve",
    sequence: 7, previous_candidate_id: null, candidate_id: "v3-active",
    actor_id: "actor", applied_at: 3, signed_pointer_json: pointer,
  });
  for (const [kind, state] of [["result", "sent"], ["review", "sending"]]) {
    insert(db, "forecast_runtime_outbox", {
      outbox_id: `${kind}:historical`, environment: "production", kind, review_id: review,
      operation_id: kind === "result" ? "historical-op" : null,
      state, attempts: 5, next_attempt_at: 12345,
      lease_token: kind === "review" ? "lease-보존" : null,
      lease_until: kind === "review" ? 12399 : null,
      message_id: kind === "result" ? "9876543210" : null, channel_id: "1234",
      error_code: kind === "review" ? "retained-retry" : null,
    });
  }
  insert(db, "source_processing_claims", {
    source: "naver-board-56", item_id: "100", claim_token: "claim", lease_until: later,
    attempted_at: at, source_generation: 7, consecutive_failures: 2, result_token: null,
    next_retry_at: later, last_checked_at: at,
  });
  insert(db, "source_manual_resolution_evidence", {
    review_id: reviewId(3), content_hash: h("manual"), created_at: at,
  });
  insert(db, "source_notice_revisions", {
    source: "naver-board-56", item_id: "100", source_revision: 1,
    body_hash: h("body"), revision_hash: h("revision"), semantic_hash: h("semantic"),
    item_json: '{"text":"공지 🌙","nullable":null}', events_json: "[]", observed_at: at,
  });
  insert(db, "schedule_event_source_revisions", {
    event_id: "event-legacy", source: "naver-board-56", item_id: "100", source_revision: 1,
  });
  insert(db, "runtime_ingestion_runs", {
    token: "expired-ingestion", status: "expired", started_at: at, lease_until: later,
    finished_at: later, error_code: "expired", candidate_id: "v3-old",
  });
  insert(db, "runtime_notice_requests", {
    request_id: "request-1", run_token: "expired-ingestion", utc_day: "2020-02-03",
    source: "naver-board-56", item_id: "100", reserved_at: at, outcome: "failure",
    error_code: "retained", content_hash: h("body"),
  });
  insert(db, "runtime_ingestion_items", {
    source: "naver-board-56", item_id: "100", checked_at: at, next_check_at: later, failures: 3,
  });
  insert(db, "runtime_ingestion_commits", {
    run_token: "expired-ingestion", committed_at: at, queue_snapshot: '[{"opaque":"보존"}]',
  });
  if (through >= 33) {
    insert(db, "forecast_v2_calendar_snapshots", {
      snapshot_id: "calendar", range_start: "2020-01-01", range_end: "2020-01-02",
      content_hash: h("calendar"), created_at: at,
    });
    insert(db, "forecast_v2_calendar_days", {
      snapshot_id: "calendar", game_day: "2020-01-01", payload_json: '{"day":"한글","x":null}',
    });
    insert(db, "forecast_v2_calendar_active", {
      singleton: 1, snapshot_id: "calendar", version: 9, updated_at: at,
    });
    insert(db, "forecast_v2_decision_requests", {
      decision_id: "expired-decision", type: "solo_review", event_id: null,
      payload_json: '{"질문":"그대로"}', payload_hash: h("decision"), expected_calendar_revision: 0,
      expires_at: later, reminder_sent_at: at, status: "expired", created_at: at,
    });
    for (const [id, state] of [["sending", "sending"], ["sent", "sent"]]) {
      const payload = '{"공지":"보존 🌙","nullable":null}';
      insert(db, "forecast_v2_notification_outbox", {
        outbox_id: id, idempotency_key: `dedup-${id}`, kind: "calendar_changed",
        snapshot_id: "calendar", decision_id: null, channel_role: "activity",
        payload_json: payload, payload_hash: h(payload), state, attempts: 6, next_attempt_at: 9988,
        lease_token: state === "sending" ? "retained-lease" : null,
        lease_until: state === "sending" ? 9999 : null,
        message_id: state === "sent" ? "55555555" : null, channel_id: "4444",
        error_code: state === "sending" ? "retry" : null, created_at: at, updated_at: later,
      });
    }
  }
}

function fixture(through, bootstrap = false) {
  const db = new DatabaseSync(":memory:");
  try {
    fixtureDDL(db, through, bootstrap);
    historicalSeed(db, () => {
      seedCommon(db);
      if (through >= 26) seedRuntime(db, through);
    });
    integrity(db);
    const count = tableNames(db).reduce((sum, table) =>
      sum + rows(db, `SELECT count(*) AS n FROM "${table}"`)[0].n, 0);
    assert.ok(count <= 250, `fixture ${through}: ${count} seeded/generated setup rows`);
    console.log(JSON.stringify({ fixture: through, bootstrap, rows: count }));
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function transport(db, afterFile = () => {}) {
  const files = [];
  const spawn = (_command, args) => {
    assert.ok(args.includes("--local") && !args.includes("--remote"), "local-only target");
    try {
      let results;
      const fileIndex = args.indexOf("--file");
      if (fileIndex >= 0) {
        const file = args[fileIndex + 1];
        assert.notEqual(file, resolve(root, "forecast-collector/schema.sql"), "no bootstrap on retained fixture");
        files.push(file);
        const version = migrations.find((m) => m.file === file).version;
        const before = snapshot(db);
        atomic(db, readFileSync(file, "utf8"));
        afterFile(version, before);
        results = [];
      } else {
        const command = args.find((arg) => arg.startsWith("--command="));
        assert.ok(command, "real runner's equals-form command");
        results = rows(db, command.slice("--command=".length));
      }
      const stdout = JSON.stringify([{ success: true, results }]);
      return { pid: 1, status: 0, signal: null, stdout, stderr: "", output: [null, stdout, ""] };
    } catch (error) {
      const stderr = String(error);
      return { pid: 1, status: 1, signal: null, stdout: "", stderr, output: [null, "", stderr] };
    }
  };
  return {
    files,
    run: () => applyForecastD1Migrations(options, { root, spawn, log: console.log }),
  };
}

function backfill11(db, before) {
  const bindings = rows(db, "SELECT * FROM source_manual_review_bindings");
  assert.equal(bindings.length, 1);
  const binding = bindings[0];
  const input = before.tables.source_queue.rows.find((r) => r.item_id === "100");
  const sourceInput = before.tables.source_items.rows.find((r) => r.item_id === "100");
  assert.equal(binding.review_id, reviewId(1));
  assert.equal(binding.source_revision, 0);
  assert.equal(binding.body_hash, sourceInput.content_hash);
  assert.equal(binding.generation, input.review_generation);
  assert.match(binding.review_token, /^[0-9a-f]{64}$/);
  assert.equal(binding.item_json, null);
  assert.deepEqual(JSON.parse(binding.metadata_json), {
    source: input.source, itemId: input.item_id, url: input.url, title: input.title,
    publishedAt: input.published_at, official: input.official,
  });
  const baseline = rows(db, "SELECT * FROM source_legacy_event_baselines");
  assert.equal(baseline.length, 1);
  const event = before.tables.schedule_events.rows[0];
  assert.equal(baseline[0].event_id, event.event_id);
  assert.equal(baseline[0].body_available, 0);
  assert.deepEqual(JSON.parse(baseline[0].source_json), {
    source: sourceInput.source, itemId: sourceInput.item_id, url: sourceInput.url,
    title: sourceInput.title, excerpt: sourceInput.excerpt, publishedAt: sourceInput.published_at,
    contentHash: sourceInput.content_hash, official: true,
  });
  assert.deepEqual(JSON.parse(baseline[0].event_json), {
    eventId: event.event_id, eventType: event.event_type, startsAt: event.starts_at,
    endsAt: event.ends_at, scheduleStatus: event.schedule_status, reason: event.reason,
  });
  assert.deepEqual(rows(db, "SELECT * FROM source_notice_revisions"), []);
}

test("missing separately approved 0005 refuses the historical chain before any write", () => {
  const db = fixture(10);
  try {
    const before = snapshot(db);
    const runner = transport(db);
    assert.throws(runner.run, /migration_prerequisite_missing/);
    assert.deepEqual(runner.files, []);
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

test("duplicate day/revision stops 0011 without deleting either retained candidate", () => {
  const db = fixture(10);
  try {
    atomic(db, source(5));
    db.exec(`INSERT INTO forecast_candidates
      SELECT 'duplicate',forecast_id,schedule_event_id,game_day,revision,source_status,state,
        payload_json,'${h("duplicate")}',created_at,updated_at
      FROM forecast_candidates WHERE candidate_id='legacy-1'`);
    const before = snapshot(db);
    const runner = transport(db);
    assert.throws(runner.run, /duplicate_candidate_revision_preflight/);
    assert.deepEqual(runner.files, []);
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

test("real 0005 then 0011–0034 preserves historical inputs; checks intended changes separately", () => {
  const db = fixture(10);
  try {
    const before5 = snapshot(db);
    atomic(db, source(5));
    preserve(db, before5, 5);
    assert.equal(rows(db, "SELECT version FROM schema_migrations WHERE version=5").length, 1);
    const runner = transport(db, (version, before) => {
      preserve(db, before, version);
      if (version === 11) backfill11(db, before);
      if (version === 13) insert(db, "staging_adoption_infrastructure_circuit", {
        singleton_id: 1, state: "blocked", attempts: 4, error_code: "retained-error",
        first_failed_at: at, next_probe_at: later, probe_token: null,
        probe_lease_until: null, updated_at: later,
      });
      if (version === 15) {
        const circuit = before.tables.staging_adoption_infrastructure_circuit.rows[0];
        const control = rows(db, "SELECT * FROM staging_adoption_recovery_control")[0];
        const episode = rows(db, "SELECT * FROM staging_adoption_hold_episodes")[0];
        assert.equal(control.state, "held");
        assert.equal(control.failure_generation, 1);
        assert.equal(control.error_code, circuit.error_code);
        assert.equal(episode.legacy_history_unknown, 1);
        assert.equal(episode.probe_attempts_at_hold, circuit.attempts);
        assert.equal(episode.held_at, control.updated_at);
        assert.notEqual(episode.held_at, circuit.first_failed_at);
      }
      if (version === 25) {
        assert.deepEqual(rows(db, "SELECT page_size FROM source_poll_state"), [{ page_size: 10 }]);
      }
      if (version === 30) {
        assert.deepEqual(rows(db, "SELECT stream_id FROM forecast_v2_monitors ORDER BY stream_id"),
          ["A", "B", "C-open", "C-reopen", "D", "E", "F", "G"].map((stream_id) => ({ stream_id })));
        assert.equal(rows(db, "SELECT * FROM forecast_v2_monitor_state").length, 8);
        assert.deepEqual(rows(db, "SELECT * FROM forecast_v2_rules_queue"), []);
        assert.deepEqual(rows(db, "SELECT * FROM forecast_v2_legacy_links"), []);
      }
    });
    const result = runner.run();
    assert.deepEqual(result.applied, Array.from({ length: 24 }, (_, i) => i + 11));
    assert.ok(!result.versions.includes(4) && !result.versions.includes(6));
    const committed = snapshot(db);
    runner.files.length = 0;
    assert.deepEqual(runner.run().applied, []);
    assert.deepEqual(runner.files, []);
    assert.deepEqual(snapshot(db), committed);
  } finally { db.close(); }
});

for (const [through, version] of [[26, 27], [33, 34]]) {
  test(`populated schema ${through}: ${String(version).padStart(4, "0")} preserves bytes, graph and positional contracts`, () => {
    const db = fixture(through);
    try {
      const before = snapshot(db);
      atomic(db, source(version));
      preserve(db, before, version);
      assert.equal(rows(db, `SELECT version FROM schema_migrations WHERE version=${version}`).length, 1);
      assert.deepEqual(rows(db, "SELECT sequence FROM forecast_runtime_active"), [{ sequence: 7 }]);
      const committed = snapshot(db);
      const runner = transport(db, (v, original) => preserve(db, original, v));
      runner.run();
      const completed = snapshot(db);
      runner.files.length = 0;
      assert.deepEqual(runner.run().applied, []);
      assert.deepEqual(runner.files, []);
      assert.deepEqual(snapshot(db), completed);
      for (const table of ["forecast_runtime_outbox", "forecast_runtime_activation_history",
        ...(through === 33 ? ["forecast_v2_notification_outbox"] : [])])
        assert.deepEqual(completed.tables[table].rows, committed.tables[table].rows);
    } finally { db.close(); }
  });
  const destructiveBoundary = version === 27
    ? "CREATE TABLE source_watermarks ("
    : "CREATE TABLE forecast_runtime_versions (";
  const ledgerBoundary = `INSERT INTO schema_migrations(version,applied_at) VALUES(${version},CURRENT_TIMESTAMP);`;
  for (const [label, boundary] of [
    ["after destructive DDL", destructiveBoundary],
    ["before ledger completion", ledgerBoundary],
  ]) {
    test(`schema ${through}: rollback ${version} ${label}, then restart without duplicate outcomes`, () => {
      const db = fixture(through);
      try {
        const before = snapshot(db);
        assert.throws(() => atomic(db, source(version), boundary), /preservation_injected_failure/);
        assert.deepEqual(snapshot(db), before);
        integrity(db);
        const runner = transport(db, (v, original) => preserve(db, original, v));
        const result = runner.run();
        assert.equal(result.applied[0], version);
        const committed = snapshot(db);
        runner.files.length = 0;
        assert.deepEqual(runner.run().applied, []);
        assert.deepEqual(runner.files, []);
        assert.deepEqual(snapshot(db), committed);
      } finally { db.close(); }
    });
  }
}

test("populated bootstrap-derived schema26 also preserves source_queue positional values", () => {
  const db = fixture(26, true);
  try {
    const before = snapshot(db);
    atomic(db, source(27));
    preserve(db, before, 27);
  } finally { db.close(); }
});

test("final PK/FK/unique/index/immutable-trigger fences still reject invalid writes", () => {
  const db = fixture(33);
  try {
    atomic(db, source(34));
    const before = snapshot(db);
    for (const sql of [
      "UPDATE forecast_runtime_versions SET sealed_at=9",
      "DELETE FROM forecast_runtime_reviews",
      "UPDATE forecast_runtime_active SET sequence=99",
      "DELETE FROM forecast_runtime_activation_history",
      "DELETE FROM forecast_runtime_outbox",
      "UPDATE source_notice_revisions SET observed_at='changed'",
    ]) assert.throws(() => db.exec(sql), /immutable|direct_write/);
    assert.throws(() => db.exec(
      "INSERT INTO candidate_sources VALUES('missing','naver-board-56','100')",
    ), /FOREIGN KEY/);
    assert.throws(() => db.exec(
      "INSERT INTO source_watermarks SELECT * FROM source_watermarks",
    ), /UNIQUE/);
    assert.deepEqual(snapshot(db), before);
    integrity(db);
  } finally { db.close(); }
});
