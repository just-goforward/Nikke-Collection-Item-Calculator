import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  database,
  result,
  root,
  type Spawn,
  sqliteRunner,
} from "./forecast-migration-test-fixtures.ts";
import { legacyDatabase } from "./forecast-migration-v27-fixtures.ts";
import {
  insertExceptionAudit,
  seedExceptionHistory,
} from "./forecast-recovery-migration-fixtures.ts";

const POLL_RECOVERY_MIGRATION = resolve(
  root,
  "forecast-collector/migrations/0020_source_poll_recovery_audits.sql",
);
const POLL_RECOVERY_TABLES = ["source_poll_recovery_previews", "source_poll_recovery_audits"];

function expectedMigrationVersions(environment: "staging" | "production") {
  return Array.from({ length: 33 }, (_, index) => index + 1).filter(
    (version) => environment === "staging" || ![4, 5, 6].includes(version),
  );
}

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
        applied: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33],
        versions: expectedMigrationVersions(environment),
      });
      expect(runner.files()).toEqual([
        "0020_source_poll_recovery_audits.sql",
        "0021_source_poll_marker_recovery_audits.sql",
        "0022_forecast_runtime_versions.sql",
        "0023_forecast_runtime_publication.sql",
        "0024_runtime_ingestion.sql",
        "0025_naver_page_policy.sql",
        "0026_source_judgment_evidence.sql",
        "0027_board11_grants.sql",
        "0028_publication_exclusions.sql",
        "0029_candidate_replay_cache.sql",
        "0030_monitor_streams.sql",
        "0031_calendar_decisions.sql",
        "0032_grant_occurrences.sql",
        "0033_calendar_snapshots.sql",
      ]);
      expect(legacyTableSnapshot(db, oldTables)).toEqual(withPublicationProtections(before));
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
      expect(legacyTableSnapshot(db, oldTables)).toEqual(withPublicationProtections(before));
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
});

describe("REVIEW19 source poll recovery migration restart behavior", () => {
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
      expect(runner.run({ environment, local: true }).applied).toEqual([
        20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
      ]);
      expect(runner.files()).toEqual([
        "0020_source_poll_recovery_audits.sql",
        "0021_source_poll_marker_recovery_audits.sql",
        "0022_forecast_runtime_versions.sql",
        "0023_forecast_runtime_publication.sql",
        "0024_runtime_ingestion.sql",
        "0025_naver_page_policy.sql",
        "0026_source_judgment_evidence.sql",
        "0027_board11_grants.sql",
        "0028_publication_exclusions.sql",
        "0029_candidate_replay_cache.sql",
        "0030_monitor_streams.sql",
        "0031_calendar_decisions.sql",
        "0032_grant_occurrences.sql",
        "0033_calendar_snapshots.sql",
      ]);
      expect(legacyTableSnapshot(db, oldTables)).toEqual(withPublicationProtections(before));
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
      expect(runner.run({ environment, local: true }).applied).toEqual([
        21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
      ]);
      expect(runner.files()).toEqual([
        "0021_source_poll_marker_recovery_audits.sql",
        "0022_forecast_runtime_versions.sql",
        "0023_forecast_runtime_publication.sql",
        "0024_runtime_ingestion.sql",
        "0025_naver_page_policy.sql",
        "0026_source_judgment_evidence.sql",
        "0027_board11_grants.sql",
        "0028_publication_exclusions.sql",
        "0029_candidate_replay_cache.sql",
        "0030_monitor_streams.sql",
        "0031_calendar_decisions.sql",
        "0032_grant_occurrences.sql",
        "0033_calendar_snapshots.sql",
      ]);
      expect(
        db.prepare("SELECT * FROM schema_migrations WHERE version<=20 ORDER BY version").all(),
      ).toEqual(ledger);
      expect(legacyTableSnapshot(db, oldTables)).toEqual(withPublicationProtections(before));
    },
  );
});

describe("REVIEW19 source poll recovery schema and immutable evidence", () => {
  it("keeps fresh v33 and incremental v33 poll recovery columns, keys, indexes and immutable triggers equal", () => {
    const upgraded = legacyDatabase(19);
    sqliteRunner(upgraded).run();
    const fresh = database();
    const runner = sqliteRunner(fresh);
    expect(runner.run().bootstrapped).toBe(true);
    expect(runner.files()).toEqual([
      "schema.sql",
      "0022_forecast_runtime_versions.sql",
      "0023_forecast_runtime_publication.sql",
      "0024_runtime_ingestion.sql",
      "0025_naver_page_policy.sql",
      "0026_source_judgment_evidence.sql",
      "0027_board11_grants.sql",
      "0028_publication_exclusions.sql",
      "0029_candidate_replay_cache.sql",
      "0030_monitor_streams.sql",
      "0031_calendar_decisions.sql",
      "0032_grant_occurrences.sql",
      "0033_calendar_snapshots.sql",
    ]);
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
    expect(fresh.prepare("PRAGMA table_info(source_poll_state)").all()).toEqual(
      upgraded.prepare("PRAGMA table_info(source_poll_state)").all(),
    );
    for (const db of [fresh, upgraded]) {
      expect(
        db
          .prepare("PRAGMA table_info(source_poll_state)")
          .all()
          .find((row) => row["name"] === "page_size"),
      ).toEqual({
        cid: 7,
        name: "page_size",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "10",
        pk: 0,
      });
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
        version: 33,
      });
    }
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
        expect(legacyTableSnapshot(db, oldTables)).toEqual(withPublicationProtections(before));
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
  for (const [key, context] of [
    ["naver-boundary:missing", '{"cursor":88}'],
    ["naver-boundary:null", '{"pageSize":null,"cursor":88}'],
    ["naver-boundary:existing", '{"pageSize":5,"cursor":88}'],
    ["other:missing", '{"cursor":88}'],
  ] as const) {
    db.prepare(`INSERT INTO forecast_ops_alerts
      (alert_key,environment,severity,component,error_code,state,context_json,first_seen_at,last_seen_at)
      VALUES(?,?,'warning','collector','source_cursor_recovery_required','open',?,'2026-10-01','2026-10-01')`).run(
      key,
      environment,
      context,
    );
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

// Existing v19 tables rebuilt by 0027; everything else must retain its original
// catalog, including legitimate bootstrap-versus-upgrade schema differences.
const REBUILT_LEGACY_TABLES = new Set([
  "source_watermarks",
  "source_items",
  "source_poll_state",
  "source_queue",
  "source_manual_reviews",
  "source_collection_health",
  "source_processor_state",
  "source_processor_runs",
  "schedule_events",
  "forecast_candidates",
  "candidate_sources",
  "source_processing_claims",
  "forecast_candidate_semantics",
  "source_manual_resolution_evidence",
  "source_manual_review_bindings",
  "schedule_event_source_revisions",
  "source_legacy_event_baselines",
  "source_metadata_observations",
  "source_poll_scan_status",
  "source_processor_item_bindings",
  "source_processor_incidents",
  "source_processor_incident_heads",
  "source_processor_detail_settlements",
  "source_processor_recovery_receipts",
  "source_processor_control_reservations",
  "source_processor_control_results",
  "source_processor_recovery_probes",
  "source_processor_item_exceptions",
  "source_processor_exception_resolutions",
  "source_processor_proof_invalidations",
  "source_processor_target_reservations",
  "source_processor_exception_audits",
]);

function withPublicationProtections(snapshot: ReturnType<typeof legacyTableSnapshot>) {
  const expected = database();
  expected.exec(
    readFileSync(resolve(root, "forecast-collector/fixtures/schema-v27-test.sql"), "utf8"),
  );
  return snapshot.map((entry) => ({
    ...entry,
    // Preserve every old value; only the approved new nullable/defaulted columns and backfill differ.
    rows: entry.rows.map((row) => {
      if (entry.table === "source_poll_state") return { ...row, page_size: 10 };
      if (entry.table === "schedule_events") return { ...row, segment_json: null };
      if (
        entry.table === "forecast_ops_alerts" &&
        ["naver-boundary:missing", "naver-boundary:null"].includes(String(row["alert_key"]))
      )
        return {
          ...row,
          context_json:
            row["alert_key"] === "naver-boundary:missing"
              ? '{"cursor":88,"pageSize":10}'
              : '{"pageSize":10,"cursor":88}',
        };
      return row;
    }),
    schema: REBUILT_LEGACY_TABLES.has(entry.table)
      ? expected
          .prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? ORDER BY type,name")
          .all(entry.table)
      : entry.schema,
  }));
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
