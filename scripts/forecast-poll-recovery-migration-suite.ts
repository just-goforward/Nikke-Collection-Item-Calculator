import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  database,
  legacyDatabase,
  result,
  root,
  type Spawn,
  sqliteRunner,
} from "./forecast-migration-test-fixtures.ts";
import {
  insertExceptionAudit,
  seedExceptionHistory,
} from "./forecast-recovery-migration-fixtures.ts";

const POLL_RECOVERY_MIGRATION = resolve(
  root,
  "forecast-collector/migrations/0020_source_poll_recovery_audits.sql",
);
const POLL_RECOVERY_TABLES = ["source_poll_recovery_previews", "source_poll_recovery_audits"];

describe("REVIEW19 create-only source poll recovery migration 20", () => {
  it.each(["staging", "production"] as const)(
    "upgrades v19 %s without changing any existing schema, cursor, health or evidence",
    (environment) => {
      const db = preservedPollRecoveryDatabase(environment);
      const oldTables = legacyTableNames(db);
      const before = legacyTableSnapshot(db, oldTables);
      expect(pollRecoveryTables(db)).toEqual([]);
      const runner = sqliteRunner(db);
      expect(runner.run({ environment, local: true })).toEqual({
        bootstrapped: false,
        applied: [20, 21],
        versions: Array.from({ length: 21 }, (_, index) => index + 1).filter(
          (version) => environment === "staging" || ![4, 5, 6].includes(version),
        ),
      });
      expect(runner.files()).toEqual([
        "0020_source_poll_recovery_audits.sql",
        "0021_source_poll_marker_recovery_audits.sql",
      ]);
      expect(legacyTableSnapshot(db, oldTables)).toEqual(before);
      expect(pollRecoveryTables(db)).toEqual([...POLL_RECOVERY_TABLES].sort());
      for (const table of POLL_RECOVERY_TABLES)
        expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
      const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      runner.spawn.mockClear();
      expect(runner.run({ environment, local: true }).applied).toEqual([]);
      expect(runner.files()).toEqual([]);
      for (let replay = 0; replay < 2; replay++)
        db.exec(readFileSync(POLL_RECOVERY_MIGRATION, "utf8"));
      expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(ledger);
      expect(legacyTableSnapshot(db, oldTables)).toEqual(before);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      if (environment === "production") {
        expect(
          db.prepare("SELECT version FROM schema_migrations WHERE version IN (4,5,6)").all(),
        ).toEqual([]);
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'discord_staging_%'").all(),
        ).toEqual([]);
      }
    },
  );

  it.each(["staging", "production"] as const)(
    "stops before a failed migration20 in %s and then resumes from exact v19",
    (environment) => {
      const db = preservedPollRecoveryDatabase(environment);
      const oldTables = legacyTableNames(db),
        before = legacyTableSnapshot(db, oldTables);
      const runner = sqliteRunner(db),
        normal = runner.spawn.getMockImplementation() as Spawn;
      runner.spawn.mockImplementation((command, args, options) =>
        args.includes("--file")
          ? result("", { status: 1, stderr: "poll recovery migration failed" })
          : normal(command, args, options),
      );
      expect(() => runner.run({ environment, local: true })).toThrow(
        /poll recovery migration failed/,
      );
      expect(runner.files()).toEqual(["0020_source_poll_recovery_audits.sql"]);
      expect(pollRecoveryTables(db)).toEqual([]);
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
        version: 19,
      });
      expect(legacyTableSnapshot(db, oldTables)).toEqual(before);
      runner.spawn.mockImplementation(normal).mockClear();
      expect(runner.run({ environment, local: true }).applied).toEqual([20, 21]);
      expect(runner.files()).toEqual([
        "0020_source_poll_recovery_audits.sql",
        "0021_source_poll_marker_recovery_audits.sql",
      ]);
      expect(legacyTableSnapshot(db, oldTables)).toEqual(before);
    },
  );

  it.each(["staging", "production"] as const)(
    "restarts %s after migration20 commits but its subprocess response is lost",
    (environment) => {
      const db = preservedPollRecoveryDatabase(environment);
      const oldTables = legacyTableNames(db),
        before = legacyTableSnapshot(db, oldTables);
      const runner = sqliteRunner(db),
        normal = runner.spawn.getMockImplementation() as Spawn;
      runner.spawn.mockImplementation((command, args, options) => {
        const response = normal(command, args, options);
        return args.includes("--file")
          ? result("", { status: 1, stderr: "poll recovery response lost" })
          : response;
      });
      expect(() => runner.run({ environment, local: true })).toThrow(/poll recovery response lost/);
      expect(runner.files()).toEqual(["0020_source_poll_recovery_audits.sql"]);
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
        version: 20,
      });
      expect(legacyTableSnapshot(db, oldTables)).toEqual(before);
      const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      runner.spawn.mockImplementation(normal).mockClear();
      expect(runner.run({ environment, local: true }).applied).toEqual([21]);
      expect(runner.files()).toEqual(["0021_source_poll_marker_recovery_audits.sql"]);
      expect(
        db.prepare("SELECT * FROM schema_migrations WHERE version<=20 ORDER BY version").all(),
      ).toEqual(ledger);
      expect(legacyTableSnapshot(db, oldTables)).toEqual(before);
    },
  );
});

describe("REVIEW19 source poll recovery schema and immutable evidence", () => {
  it("keeps fresh v21 and incremental v21 poll recovery columns, keys, indexes and immutable triggers equal", () => {
    const upgraded = legacyDatabase(19);
    sqliteRunner(upgraded).run();
    const fresh = database();
    const runner = sqliteRunner(fresh);
    expect(runner.run().bootstrapped).toBe(true);
    expect(runner.files()).toEqual(["schema.sql"]);
    for (const table of POLL_RECOVERY_TABLES) {
      for (const pragma of ["table_info", "foreign_key_list", "index_list"])
        expect(fresh.prepare(`PRAGMA ${pragma}(${table})`).all()).toEqual(
          upgraded.prepare(`PRAGMA ${pragma}(${table})`).all(),
        );
      const triggers =
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name";
      expect(fresh.prepare(triggers).all(table)).toEqual(upgraded.prepare(triggers).all(table));
      expect(fresh.prepare(triggers).all(table)).toHaveLength(
        table === "source_poll_recovery_audits" ? 4 : 3,
      );
      const indexes =
        "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name";
      expect(fresh.prepare(indexes).all(table)).toEqual(upgraded.prepare(indexes).all(table));
    }
    expect(fresh.prepare("PRAGMA foreign_key_list(source_poll_recovery_audits)").all()).toEqual([
      expect.objectContaining({
        table: "source_poll_recovery_previews",
        from: "preview_id",
        to: "preview_id",
      }),
    ]);
    for (const db of [fresh, upgraded])
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
        version: 21,
      });
  });

  it.each(["staging", "production"] as const)(
    "rejects update, delete and replacement of %s poll recovery evidence before and after reapply",
    (environment) => {
      const db = preservedPollRecoveryDatabase(environment);
      const oldTables = legacyTableNames(db),
        before = legacyTableSnapshot(db, oldTables);
      sqliteRunner(db).run({ environment, local: true });
      seedPollRecoveryEvidence(db, environment);
      const evidence = POLL_RECOVERY_TABLES.map((table) =>
        db.prepare(`SELECT * FROM ${table}`).all(),
      );
      for (const reapply of [false, true]) {
        if (reapply) db.exec(readFileSync(POLL_RECOVERY_MIGRATION, "utf8"));
        for (const table of POLL_RECOVERY_TABLES)
          for (const sql of [
            `UPDATE ${table} SET source='naver-board-48'`,
            `DELETE FROM ${table}`,
            `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`,
            `INSERT OR IGNORE INTO ${table} SELECT * FROM ${table}`,
          ])
            expect(() => db.exec(sql)).toThrow(/source_poll_recovery_evidence_immutable/);
        expect(
          POLL_RECOVERY_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
        ).toEqual(evidence);
        expect(legacyTableSnapshot(db, oldTables)).toEqual(before);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      }
    },
  );
});

describe("source poll marker recovery audit constraints", () => {
  it.each(["bootstrap", "upgrade"] as const)(
    "retains immutable recovery audits and constraints after %s",
    (installation) => {
      const db = installation === "bootstrap" ? database() : legacyDatabase(20);
      sqliteRunner(db).run();
      seedPollRecoveryEvidence(db, "staging");
      const markerPreview = "00000000-0000-4000-8000-000000000021";
      const freshPreview = "00000000-0000-4000-8000-000000000023";
      const markerOperation = "00000000-0000-4000-8000-000000000121";
      const markerRequest = "00000000-0000-4000-8000-000000000221";
      const freshOperation = "00000000-0000-4000-8000-000000000122";
      const freshRequest = "00000000-0000-4000-8000-000000000222";
      for (const preview of [markerPreview, freshPreview]) {
        db.prepare(`INSERT INTO source_poll_recovery_previews
          SELECT ?,source,environment,deployment_sha,before_json,before_hash,page_json,
          page_hash,plan_json,proof_hash,created_at,expires_at
          FROM source_poll_recovery_previews WHERE preview_id=?`).run(
          preview,
          "00000000-0000-4000-8000-000000000020",
        );
      }
      db.prepare(`INSERT INTO source_poll_marker_recovery_audits(operation_id,preview_id,request_id,
        request_hash,source,request_json,before_json,plan_json,page_hash,applied_at)
        VALUES(?,?,?,?,?,'{"mode":"preserve-marker","selfDeclaredActor":"Local migration fixture"}',
        '{"poll":{"committed_item_id":"8143799"}}',
        '{"mode":"preserve-marker","anchor":{"itemId":"8143799"},"unverifiedFrom":null,"unverifiedThrough":null}',?,'local-audit')`).run(
        markerOperation,
        markerPreview,
        markerRequest,
        "a".repeat(64),
        "naver-board-56",
        "a".repeat(64),
      );
      const tables = legacyTableNames(db);
      const before = legacyTableSnapshot(db, tables);
      expect(() =>
        db
          .prepare(`INSERT OR IGNORE INTO source_poll_recovery_audits
          SELECT ?,preview_id,?,request_hash,source,request_json,before_json,plan_json,
          page_hash,unverified_from,unverified_through,applied_at
          FROM source_poll_recovery_audits`)
          .run(freshOperation, freshRequest),
      ).toThrow("source_poll_recovery_evidence_immutable");
      expect(legacyTableSnapshot(db, tables)).toEqual(before);
      for (const identity of ["operation", "preview", "request"]) {
        for (const conflict of ["IGNORE", "REPLACE"]) {
          expect(() =>
            db
              .prepare(`INSERT OR ${conflict} INTO source_poll_marker_recovery_audits
              SELECT ?,?,?,request_hash,source,request_json,before_json,plan_json,page_hash,applied_at
              FROM source_poll_marker_recovery_audits`)
              .run(
                identity === "operation" ? markerOperation : freshOperation,
                identity === "preview" ? markerPreview : freshPreview,
                identity === "request" ? markerRequest : freshRequest,
              ),
          ).toThrow("source_poll_recovery_evidence_immutable");
          expect(legacyTableSnapshot(db, tables)).toEqual(before);
        }
      }
      for (const sql of [
        "UPDATE source_poll_marker_recovery_audits SET source=source",
        "DELETE FROM source_poll_marker_recovery_audits",
      ]) {
        expect(() => db.exec(sql)).toThrow("source_poll_recovery_evidence_immutable");
        expect(legacyTableSnapshot(db, tables)).toEqual(before);
      }
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );
});

function preservedPollRecoveryDatabase(environment: "staging" | "production") {
  const db = legacyDatabase(19, environment === "production");
  seedExceptionHistory(db, environment);
  insertExceptionAudit(db);
  for (const source of ["naver-board-48", "naver-board-56"]) {
    db.prepare(`INSERT INTO source_poll_state(source,committed_item_id,committed_published_at,scan_head_item_id,scan_head_published_at,next_offset,updated_at)
      VALUES(?,'8143799','2026-09-03T03:00:00Z','8200000','2026-09-25T03:00:00Z',88,'2026-10-01T00:00:00Z')`).run(
      source,
    );
    db.prepare(`INSERT INTO source_collection_health(source,last_attempt_at,last_success_at,scan_complete,gap_detected,gap_since_at,collection_failures,error_code)
      VALUES(?,'2026-10-01T00:00:00Z','2026-09-03T03:01:00Z',0,1,'2026-09-03T03:00:00Z',3,'source_cursor_recovery_required')`).run(
      source,
    );
    db.prepare(
      "INSERT INTO source_poll_scan_status(source,scan_uncertain,updated_at) VALUES(?,1,'2026-10-01T00:00:00Z')",
    ).run(source);
  }
  return db;
}

function legacyTableNames(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    )
    .all()
    .map((row) => String(row["name"]));
}

function legacyTableSnapshot(db: DatabaseSync, tables: string[]) {
  return tables.map((table) => ({
    table,
    schema: db
      .prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? ORDER BY type,name")
      .all(table),
    rows: db
      .prepare(
        table === "schema_migrations"
          ? "SELECT * FROM schema_migrations WHERE version<=19 ORDER BY version"
          : `SELECT * FROM "${table.replaceAll('"', '""')}"`,
      )
      .all(),
  }));
}

function pollRecoveryTables(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'source_poll_recovery_*' ORDER BY name",
    )
    .all()
    .map((row) => String(row["name"]));
}

function seedPollRecoveryEvidence(db: DatabaseSync, environment: "staging" | "production") {
  const previewId = "00000000-0000-4000-8000-000000000020";
  db.prepare(`INSERT INTO source_poll_recovery_previews(preview_id,source,environment,deployment_sha,before_json,before_hash,page_json,page_hash,plan_json,proof_hash,created_at,expires_at)
    VALUES(?,'naver-board-56',?,'local-migration-test','{}',?,'{}',?,'{}',?,'2026-10-02T03:00:00Z','2026-10-02T03:10:00Z')`).run(
    previewId,
    environment,
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
  );
  db.prepare(`INSERT INTO source_poll_recovery_audits(operation_id,preview_id,request_id,request_hash,source,request_json,before_json,plan_json,page_hash,unverified_from,unverified_through,applied_at)
    VALUES(?,?,?,?,'naver-board-56','{}','{}','{}',?,'2026-09-03T03:00:00Z','2026-10-02T03:00:00Z','2026-10-02T03:00:00Z')`).run(
    "00000000-0000-4000-8000-000000000021",
    previewId,
    "00000000-0000-4000-8000-000000000022",
    "d".repeat(64),
    "b".repeat(64),
  );
}
