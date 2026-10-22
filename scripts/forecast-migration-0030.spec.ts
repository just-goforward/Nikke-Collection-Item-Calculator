import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { migrations, sqliteRunner } from "./forecast-migration-test-fixtures.ts";
import { acceptedLegacyRows, legacyDatabase } from "./forecast-migration-v27-fixtures.ts";

function populatedV29() {
  const db = legacyDatabase(26);
  for (const migration of migrations.filter((m) => m.version >= 27 && m.version <= 29)) {
    db.exec(readFileSync(migration.file, "utf8"));
  }
  return db;
}

it("upgrades populated v29 without changing legacy facts and skips applied migrations", () => {
  const db = populatedV29();
  const before = acceptedLegacyRows(db);
  const runner = sqliteRunner(db);
  expect(runner.run().applied).toEqual([30, 31, 32, 33, 34]);
  expect(acceptedLegacyRows(db)).toEqual(before);
  expect(runner.run().applied).toEqual([]);
  expect(db.prepare("SELECT count(*) AS n FROM forecast_v2_monitors").get()).toEqual({ n: 8 });
  expect(db.prepare("SELECT count(*) AS n FROM forecast_v2_rules_queue").get()).toEqual({ n: 0 });
  expect(
    db
      .prepare("PRAGMA index_info(forecast_v2_rules_queue_pending)")
      .all()
      .map((row) => row["name"]),
  ).toEqual(["status", "attempts", "created_at"]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  for (const migration of migrations.filter((m) => m.version >= 30 && m.version <= 33)) {
    expect(readFileSync(migration.file, "utf8")).not.toMatch(
      /\b(?:ALTER|DROP)\s+(?:TABLE|TRIGGER)/i,
    );
  }
});

it("enqueues rules atomically in either arrival order and indexes pending work", () => {
  const db = populatedV29();
  sqliteRunner(db).run();
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`INSERT INTO forecast_v2_monitor_runs
    (run_id,stream_id,generation,kind,status,started_at)
    VALUES('a','A',1,'new','running','t'),('b','B',1,'new','running','t');
    INSERT INTO forecast_v2_search_hits VALUES('a','1','t','t','{}');`);
  db.prepare(`INSERT INTO forecast_v2_post_versions VALUES
    ('v','1','t',?,11,'t','t','body')`).run("a".repeat(64));
  db.exec("INSERT INTO forecast_v2_search_hits VALUES('b','1','t','t','{}')");
  expect(
    db
      .prepare(`SELECT stream_id,status,attempts FROM forecast_v2_rules_queue
    ORDER BY stream_id`)
      .all(),
  ).toEqual([
    { stream_id: "A", status: "pending", attempts: 0 },
    { stream_id: "B", status: "pending", attempts: 0 },
  ]);
  db.exec(`UPDATE forecast_v2_rules_queue SET status='done' WHERE stream_id='A';
    INSERT INTO forecast_v2_monitor_runs
    (run_id,stream_id,generation,kind,status,started_at)
    VALUES('a2','A',2,'new','running','t');
    INSERT INTO forecast_v2_search_hits VALUES('a2','1','t','t','{}');`);
  expect(
    db.prepare("SELECT status FROM forecast_v2_rules_queue WHERE stream_id='A'").get(),
  ).toEqual({ status: "done" });
  expect(() => db.exec("UPDATE forecast_v2_rules_queue SET attempts=4")).toThrow(/CHECK/);
  expect(() => db.exec("UPDATE forecast_v2_rules_queue SET status='unknown'")).toThrow(/CHECK/);
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT q.version_id,v.feed_id,q.stream_id
    FROM forecast_v2_rules_queue q
    JOIN forecast_v2_post_versions v ON v.version_id=q.version_id
    WHERE q.status='pending' AND q.attempts<3
    ORDER BY q.attempts,q.created_at LIMIT 1`)
    .all()
    .map((row) => row["detail"])
    .join("\n");
  expect(plan).toContain("forecast_v2_rules_queue_pending");
  expect(plan).not.toContain("TEMP B-TREE");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("enforces calendar CAS, grant deduplication and immutable decision results", () => {
  const db = populatedV29();
  sqliteRunner(db).run();
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`INSERT INTO forecast_v2_calendar_revisions(event_id,revision,kind,status,source_feed_ids_json,created_at)
    VALUES('event',1,'solo','pending','[]','t'),('event',2,'solo','confirmed','[]','t');
    INSERT INTO forecast_v2_calendar_heads VALUES('event',1);`);
  const command = db.prepare(`INSERT INTO forecast_v2_admin_commands
    (command_id,idempotency_key,payload_hash,event_id,expected_revision,created_at)
    VALUES(?,?,?,'event',?,'t')`);
  expect(() => command.run("c", "k", "a".repeat(64), 0)).toThrow("calendar_revision_conflict");
  command.run("c", "k", "a".repeat(64), 1);
  db.exec("UPDATE forecast_v2_calendar_heads SET revision=2 WHERE event_id='event' AND revision=1");
  expect(() => command.run("d", "l", "a".repeat(64), 1)).toThrow("calendar_revision_conflict");
  db.exec(`INSERT INTO forecast_v2_grant_revisions VALUES('g',1,'2026-10-18',5,0,NULL,'t'),('h',1,'2026-10-18',5,0,NULL,'t');
    INSERT INTO forecast_v2_grant_heads VALUES('g',1,'2026-10-18',5,0);`);
  expect(() =>
    db.exec("INSERT INTO forecast_v2_grant_heads VALUES('h',1,'2026-10-18',5,0)"),
  ).toThrow();
  db.prepare(`INSERT INTO forecast_v2_decision_requests
    (decision_id,type,payload_json,payload_hash,expected_calendar_revision,expires_at,reminder_sent_at,status,created_at)
    VALUES('d','grant_date','{}',?,0,'u',NULL,'pending','t')`).run("a".repeat(64));
  db.exec(`INSERT INTO forecast_v2_consumed_interactions VALUES('i','d','t');
    INSERT INTO forecast_v2_decision_results VALUES('d','i','{}','t');`);
  for (const sql of [
    "UPDATE forecast_v2_decision_results SET result_json='[]'",
    "DELETE FROM forecast_v2_decision_results",
    "INSERT OR REPLACE INTO forecast_v2_decision_results VALUES('d','i','[]','t')",
  ])
    expect(() => db.exec(sql)).toThrow("decision_result_immutable");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("supports the decision contract including requests before an event head exists", () => {
  const db = populatedV29();
  sqliteRunner(db).run();
  db.exec("PRAGMA foreign_keys=ON");
  const insert = db.prepare(`INSERT INTO forecast_v2_decision_requests
    (decision_id,type,event_id,payload_json,payload_hash,expected_calendar_revision,expires_at,status,created_at)
    VALUES(?,?,?,'{}',?,0,'2026-11-01T00:00:00Z',?,'2026-10-18T00:00:00Z')`);
  for (const type of [
    "solo_review",
    "grant_date",
    "collaboration",
    "maintenance",
    "grant_quantity",
  ]) {
    for (const status of ["pending", "resolved", "expired", "stale"]) {
      const id = `${type}-${status}`;
      insert.run(
        id,
        type,
        type.startsWith("grant_") ? null : "future-event",
        "a".repeat(64),
        status,
      );
    }
  }
  expect(db.prepare("SELECT COUNT(*) AS n FROM forecast_v2_decision_requests").get()).toEqual({
    n: 20,
  });
  expect(db.prepare("SELECT COUNT(*) AS n FROM forecast_v2_calendar_heads").get()).toEqual({
    n: 0,
  });
  expect(() =>
    insert.run("invalid-type", "solo_schedule", null, "a".repeat(64), "pending"),
  ).toThrow(/CHECK/);
  expect(() =>
    insert.run("invalid-status", "maintenance", null, "a".repeat(64), "unknown"),
  ).toThrow(/CHECK/);
  expect(
    db
      .prepare("PRAGMA index_info(forecast_v2_decision_requests_status_expiry)")
      .all()
      .map((row) => row["name"]),
  ).toEqual(["status", "expires_at"]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("applies admin-command CAS to absent, new and existing events and deduplicates decisions", () => {
  const db = populatedV29();
  sqliteRunner(db).run();
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`INSERT INTO forecast_v2_calendar_revisions
    (event_id,revision,kind,status,source_feed_ids_json,created_at)
    VALUES('existing',1,'maintenance','confirmed','[]','t');
    INSERT INTO forecast_v2_calendar_heads VALUES('existing',1);`);
  db.prepare(`INSERT INTO forecast_v2_decision_requests
    (decision_id,type,payload_json,payload_hash,expected_calendar_revision,expires_at,status,created_at)
    VALUES('decision','grant_date','{}',?,0,'u','resolved','t')`).run("a".repeat(64));
  const command = db.prepare(`INSERT INTO forecast_v2_admin_commands
    (command_id,idempotency_key,payload_hash,event_id,decision_id,expected_revision,created_at)
    VALUES(?,? ,?, ?, ?, ?, 't')`);
  command.run("null-event", "key-null", "a".repeat(64), null, "decision", 0);
  command.run("null-no-check", "key-null-no-check", "a".repeat(64), null, null, 7);
  command.run("create-event", "key-new", "a".repeat(64), "future", null, 0);
  command.run("existing-event", "key-existing", "a".repeat(64), "existing", null, 1);
  for (const [eventId, revision] of [
    ["existing", 0],
    ["existing", 2],
    ["missing", 1],
  ] as const) {
    expect(() =>
      command.run("conflict", "conflict", "a".repeat(64), eventId, null, revision),
    ).toThrow("calendar_revision_conflict");
  }
  expect(() =>
    command.run("duplicate-decision", "different-key", "a".repeat(64), null, "decision", 0),
  ).toThrow(/UNIQUE/);
  expect(() => command.run("duplicate-key", "key-null", "a".repeat(64), null, null, 0)).toThrow(
    /UNIQUE/,
  );
  expect(() =>
    command.run("missing-decision", "key-missing", "a".repeat(64), null, "unknown", 0),
  ).toThrow(/FOREIGN KEY/);
  expect(db.prepare("SELECT COUNT(*) AS n FROM forecast_v2_admin_commands").get()).toEqual({
    n: 4,
  });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
