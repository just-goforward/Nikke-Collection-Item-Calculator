import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  acceptedLegacyRows,
  database,
  legacyDatabase,
  migrations,
  result,
  root,
  type Spawn,
  sqliteRunner,
} from "./forecast-migration-test-fixtures.ts";
import {
  EXCEPTION_AT,
  EXCEPTION_ID,
  exceptionEvidenceHistory,
  insertExceptionAudit,
  insertTargetReservation,
  seedExceptionHistory,
  seedTargetHistory,
  TARGET_CLAIM,
  TARGET_ORIGIN,
  TARGET_RECOVERY,
  targetEvidenceHistory,
} from "./forecast-recovery-migration-fixtures.ts";
import "./forecast-poll-recovery-migration-suite.ts";

describe("REVIEW12 explicit recovery storage upgrades", () => {
  it.each(["staging", "production"] as const)(
    "anchors an unknown pre-v15 outage at migration time in %s and preserves accepted facts",
    (environment) => {
      const db = legacyDatabase(14, environment === "production");
      const accepted = acceptedLegacyRows(db);
      db.exec(`INSERT INTO staging_adoption_infrastructure_circuit
        (singleton_id,state,attempts,first_failed_at,error_code,updated_at)
        VALUES(1,'blocked',8,'2026-09-01T00:00:00Z','staging_adoption_github_authorization_unavailable','2026-09-30T00:00:00Z');`);
      const circuit = db.prepare("SELECT * FROM staging_adoption_infrastructure_circuit").all();
      const before = Date.now();
      const runner = sqliteRunner(db);
      expect(runner.run({ environment, local: true }).applied).toEqual([
        15, 16, 17, 18, 19, 20, 21,
      ]);
      const control = db.prepare("SELECT * FROM staging_adoption_recovery_control").get();
      const episode = db.prepare("SELECT * FROM staging_adoption_hold_episodes").get();
      expect(control).toMatchObject({
        epoch: 1,
        state: "held",
        failure_generation: 1,
        failed_stage: "unknown",
      });
      expect(episode).toMatchObject({
        epoch: 1,
        legacy_history_unknown: 1,
        probe_attempts_at_hold: 8,
        resumed_at: null,
      });
      const anchored = Date.parse(String(episode?.["held_at"]));
      expect(anchored).toBeGreaterThanOrEqual(before - 1_000);
      expect(anchored).toBeLessThanOrEqual(Date.now() + 1_000);
      expect(control?.["updated_at"]).toBe(episode?.["held_at"]);
      expect(db.prepare("SELECT * FROM staging_adoption_infrastructure_circuit").all()).toEqual(
        circuit,
      );
      expect(acceptedLegacyRows(db)).toEqual(accepted);
      const history = recoveryHistory(db);
      runner.run({ environment, local: true });
      db.exec(readFileSync(migrations.find((m) => m.version === 15)?.file as string, "utf8"));
      db.exec(readFileSync(migrations.find((m) => m.version === 16)?.file as string, "utf8"));
      db.exec(
        readFileSync(
          resolve(
            root,
            "forecast-collector/migrations/0017_source_processor_incident_evidence.sql",
          ),
          "utf8",
        ),
      );
      db.exec(
        readFileSync(
          resolve(
            root,
            "forecast-collector/migrations/0018_source_processor_target_reservations.sql",
          ),
          "utf8",
        ),
      );
      expect(recoveryHistory(db)).toEqual(history);
      expect(acceptedLegacyRows(db)).toEqual(accepted);
    },
  );

  it("does not invent an outage or approval-age credit from a healthy legacy circuit", () => {
    const db = legacyDatabase(14);
    db.exec(`INSERT INTO staging_adoption_infrastructure_circuit
      (singleton_id,state,attempts,first_failed_at,updated_at)
      VALUES(1,'healthy',2,'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z');`);
    sqliteRunner(db).run();
    expect(db.prepare("SELECT * FROM staging_adoption_recovery_control").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM staging_adoption_hold_episodes").all()).toEqual([]);
  });

  it("keeps fresh bootstrap and incremental v17 recovery columns, foreign keys and indexes equal", () => {
    const upgraded = legacyDatabase(17);
    const fresh = database();
    fresh.exec(readFileSync(resolve(root, "forecast-collector/schema.sql"), "utf8"));
    for (const table of RECOVERY_TABLES) {
      for (const pragma of ["table_info", "foreign_key_list", "index_list"])
        expect(fresh.prepare(`PRAGMA ${pragma}(${table})`).all()).toEqual(
          upgraded.prepare(`PRAGMA ${pragma}(${table})`).all(),
        );
    }
    expect(fresh.prepare("PRAGMA table_info(dispatcher_retry_proofs)").all()).toEqual(
      expect.arrayContaining(
        ["operation_at", "operation_actor", "operation_name", "operation_http_status"].map((name) =>
          expect.objectContaining({ name, notnull: 1 }),
        ),
      ),
    );
  });
});

const RECOVERY_TABLES = [
  "staging_adoption_recovery_control",
  "staging_adoption_hold_episodes",
  "staging_adoption_recovery_runs",
  "dispatcher_retry_state",
  "dispatcher_retry_attempts",
  "dispatcher_retry_proofs",
];
function recoveryHistory(db: DatabaseSync) {
  return RECOVERY_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
}

describe("REVIEW16 create-only recovery target upgrade and restart", () => {
  it.each(["staging", "production"] as const)(
    "upgrades v17 %s without rewriting incidents, claims or accepted source facts",
    (environment) => {
      const db = legacyDatabase(17, environment === "production");
      seedTargetHistory(db, environment);
      const accepted = acceptedLegacyRows(db);
      const history = targetEvidenceHistory(db);
      const previousLedger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='source_processor_target_reservations'",
          )
          .all(),
      ).toEqual([]);
      const runner = sqliteRunner(db);
      expect(runner.run({ environment, local: true }).applied).toEqual([18, 19, 20, 21]);
      expect(runner.files()).toEqual([
        "0018_source_processor_target_reservations.sql",
        "0019_source_processor_exception_audits.sql",
        "0020_source_poll_recovery_audits.sql",
        "0021_source_poll_marker_recovery_audits.sql",
      ]);
      expect(
        db.prepare("SELECT * FROM schema_migrations WHERE version<18 ORDER BY version").all(),
      ).toEqual(previousLedger);
      expect(db.prepare("SELECT * FROM source_processor_target_reservations").all()).toEqual([]);
      expect(targetEvidenceHistory(db)).toEqual(history);
      expect(acceptedLegacyRows(db)).toEqual(accepted);
      insertTargetReservation(db);
      const reservations = db.prepare("SELECT * FROM source_processor_target_reservations").all();
      expect(reservations).toEqual([
        expect.objectContaining({
          recovery_run_token: TARGET_RECOVERY,
          origin_run_token: TARGET_ORIGIN,
          source_generation: 4,
          item_claim_token: TARGET_CLAIM,
          metadata_json: '{"generation":4}',
        }),
      ]);
      expect(db.prepare("SELECT source_generation FROM source_processor_incidents").all()).toEqual([
        { source_generation: 1 },
      ]);
      const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      runner.spawn.mockClear();
      expect(runner.run({ environment, local: true }).applied).toEqual([]);
      expect(runner.files()).toEqual([]);
      db.exec(readFileSync(TARGET_MIGRATION, "utf8"));
      db.exec(readFileSync(TARGET_MIGRATION, "utf8"));
      expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(ledger);
      expect(db.prepare("SELECT * FROM source_processor_target_reservations").all()).toEqual(
        reservations,
      );
      expect(targetEvidenceHistory(db)).toEqual(history);
      expect(acceptedLegacyRows(db)).toEqual(accepted);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );

  it("keeps current bootstrap and incremental v18 target columns, keys and immutable triggers equal", () => {
    const upgraded = legacyDatabase(18);
    const fresh = database();
    fresh.exec(readFileSync(resolve(root, "forecast-collector/schema.sql"), "utf8"));
    for (const pragma of ["table_info", "foreign_key_list", "index_list"])
      expect(fresh.prepare(`PRAGMA ${pragma}(source_processor_target_reservations)`).all()).toEqual(
        upgraded.prepare(`PRAGMA ${pragma}(source_processor_target_reservations)`).all(),
      );
    const triggers =
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='source_processor_target_reservations' ORDER BY name";
    expect(fresh.prepare(triggers).all()).toEqual(upgraded.prepare(triggers).all());
    expect(fresh.prepare(triggers).all()).toHaveLength(3);
    expect(fresh.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 21,
    });
    expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual(
      { version: 18 },
    );
  });
});

describe("REVIEW16 recovery target evidence constraints", () => {
  it.each(["staging", "production"] as const)(
    "rejects update, deletion and replacement of reserved %s evidence before and after reapply",
    (environment) => {
      const db = legacyDatabase(18, environment === "production");
      seedTargetHistory(db, environment);
      insertTargetReservation(db);
      const history = targetEvidenceHistory(db);
      const accepted = acceptedLegacyRows(db);
      const reservations = db.prepare("SELECT * FROM source_processor_target_reservations").all();
      for (const reapply of [false, true]) {
        if (reapply) db.exec(readFileSync(TARGET_MIGRATION, "utf8"));
        for (const sql of [
          "UPDATE source_processor_target_reservations SET source_generation=5",
          "DELETE FROM source_processor_target_reservations",
          "INSERT OR REPLACE INTO source_processor_target_reservations SELECT * FROM source_processor_target_reservations",
          "INSERT OR IGNORE INTO source_processor_target_reservations SELECT * FROM source_processor_target_reservations",
        ])
          expect(() => db.exec(sql)).toThrow(/source_processor_evidence_immutable/);
        expect(db.prepare("SELECT * FROM source_processor_target_reservations").all()).toEqual(
          reservations,
        );
        expect(targetEvidenceHistory(db)).toEqual(history);
        expect(acceptedLegacyRows(db)).toEqual(accepted);
      }
    },
  );

  it.each([
    { column: "source_generation", expression: "-1", constraint: /CHECK constraint/ },
    { column: "item_claim_token", expression: "'short'", constraint: /CHECK constraint/ },
    { column: "metadata_json", expression: "'not-json'", constraint: /CHECK constraint/ },
    { column: "source", expression: "NULL", constraint: /NOT NULL constraint/ },
    {
      column: "recovery_run_token",
      expression: "'00000000-0000-4000-8000-000000000099'",
      constraint: /FOREIGN KEY constraint/,
    },
    {
      column: "origin_run_token",
      expression: "'00000000-0000-4000-8000-000000000099'",
      constraint: /FOREIGN KEY constraint/,
    },
  ])(
    "rejects an invalid new reservation $column without changing prior evidence",
    ({ column, expression, constraint }) => {
      const db = legacyDatabase(18);
      seedTargetHistory(db, "staging");
      insertTargetReservation(db);
      const history = targetEvidenceHistory(db);
      const reservations = db.prepare("SELECT * FROM source_processor_target_reservations").all();
      const columns = db
        .prepare("PRAGMA table_info(source_processor_target_reservations)")
        .all()
        .map((field) => String(field["name"]));
      const values = columns.map((name) =>
        name === "request_id" ? "'invalid-new-request'" : name === column ? expression : name,
      );
      expect(() =>
        db.exec(
          `INSERT INTO source_processor_target_reservations SELECT ${values.join(",")} FROM source_processor_target_reservations`,
        ),
      ).toThrow(constraint);
      expect(db.prepare("SELECT * FROM source_processor_target_reservations").all()).toEqual(
        reservations,
      );
      expect(targetEvidenceHistory(db)).toEqual(history);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );
});

const TARGET_MIGRATION = resolve(
  root,
  "forecast-collector/migrations/0018_source_processor_target_reservations.sql",
);

const EXCEPTION_AUDIT_MIGRATION = resolve(
  root,
  "forecast-collector/migrations/0019_source_processor_exception_audits.sql",
);

describe("C15 policy addendum create-only exception audit upgrade", () => {
  it.each(["staging", "production"] as const)(
    "upgrades v18 %s without changing incidents, reservations, exceptions or accepted facts",
    (environment) => {
      const db = legacyDatabase(18, environment === "production");
      seedExceptionHistory(db, environment);
      const accepted = acceptedLegacyRows(db);
      const history = exceptionEvidenceHistory(db);
      const previousLedger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name='source_processor_exception_audits'")
          .all(),
      ).toEqual([]);
      const runner = sqliteRunner(db);
      expect(runner.run({ environment, local: true }).applied).toEqual([19, 20, 21]);
      expect(runner.files()).toEqual([
        "0019_source_processor_exception_audits.sql",
        "0020_source_poll_recovery_audits.sql",
        "0021_source_poll_marker_recovery_audits.sql",
      ]);
      expect(
        db.prepare("SELECT * FROM schema_migrations WHERE version<19 ORDER BY version").all(),
      ).toEqual(previousLedger);
      expect(db.prepare("SELECT * FROM source_processor_exception_audits").all()).toEqual([]);
      expect(exceptionEvidenceHistory(db)).toEqual(history);
      expect(acceptedLegacyRows(db)).toEqual(accepted);
      if (environment === "production") {
        expect(
          db.prepare("SELECT version FROM schema_migrations WHERE version IN (4,5,6)").all(),
        ).toEqual([]);
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'discord_staging_%'").all(),
        ).toEqual([]);
      }
      insertExceptionAudit(db);
      const audits = db.prepare("SELECT * FROM source_processor_exception_audits").all();
      const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      runner.spawn.mockClear();
      expect(runner.run({ environment, local: true }).applied).toEqual([]);
      expect(runner.files()).toEqual([]);
      db.exec(readFileSync(EXCEPTION_AUDIT_MIGRATION, "utf8"));
      db.exec(readFileSync(EXCEPTION_AUDIT_MIGRATION, "utf8"));
      expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(ledger);
      expect(db.prepare("SELECT * FROM source_processor_exception_audits").all()).toEqual(audits);
      expect(exceptionEvidenceHistory(db)).toEqual(history);
      expect(acceptedLegacyRows(db)).toEqual(accepted);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );

  it.each(["staging", "production"] as const)(
    "restarts v18 %s after migration 19 commits but its subprocess response is lost",
    (environment) => {
      const db = legacyDatabase(18, environment === "production");
      seedExceptionHistory(db, environment);
      const accepted = acceptedLegacyRows(db);
      const history = exceptionEvidenceHistory(db);
      const runner = sqliteRunner(db);
      const normal = runner.spawn.getMockImplementation() as Spawn;
      runner.spawn.mockImplementation((command, args, options) => {
        const response = normal(command, args, options);
        return args.includes("--file")
          ? result("", { status: 1, stderr: "audit response lost" })
          : response;
      });
      expect(() => runner.run({ environment, local: true })).toThrow(/audit response lost/);
      expect(runner.files()).toEqual(["0019_source_processor_exception_audits.sql"]);
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
        version: 19,
      });
      const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      runner.spawn.mockImplementation(normal).mockClear();
      expect(runner.run({ environment, local: true }).applied).toEqual([20, 21]);
      expect(runner.files()).toEqual([
        "0020_source_poll_recovery_audits.sql",
        "0021_source_poll_marker_recovery_audits.sql",
      ]);
      expect(
        db.prepare("SELECT * FROM schema_migrations WHERE version<=19 ORDER BY version").all(),
      ).toEqual(ledger);
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
        version: 21,
      });
      expect(db.prepare("SELECT * FROM source_processor_exception_audits").all()).toEqual([]);
      expect(exceptionEvidenceHistory(db)).toEqual(history);
      expect(acceptedLegacyRows(db)).toEqual(accepted);
    },
  );

  it("keeps current bootstrap and incremental v19 audit columns, foreign keys and immutable triggers equal", () => {
    const upgraded = legacyDatabase(19);
    const fresh = database();
    fresh.exec(readFileSync(resolve(root, "forecast-collector/schema.sql"), "utf8"));
    for (const pragma of ["table_info", "foreign_key_list", "index_list"])
      expect(fresh.prepare(`PRAGMA ${pragma}(source_processor_exception_audits)`).all()).toEqual(
        upgraded.prepare(`PRAGMA ${pragma}(source_processor_exception_audits)`).all(),
      );
    expect(
      fresh.prepare("PRAGMA foreign_key_list(source_processor_exception_audits)").all(),
    ).toEqual([
      expect.objectContaining({
        table: "source_processor_item_exceptions",
        from: "exception_id",
        to: "exception_id",
      }),
    ]);
    const triggers =
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='source_processor_exception_audits' ORDER BY name";
    expect(fresh.prepare(triggers).all()).toEqual(upgraded.prepare(triggers).all());
    expect(fresh.prepare(triggers).all()).toHaveLength(3);
    expect(fresh.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 21,
    });
    expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual(
      { version: 19 },
    );
  });
});

describe("C15 policy addendum exception audit evidence constraints", () => {
  it.each(["staging", "production"] as const)(
    "rejects update, deletion and replacement of %s audit evidence before and after reapply",
    (environment) => {
      const db = legacyDatabase(19, environment === "production");
      seedExceptionHistory(db, environment);
      insertExceptionAudit(db);
      const history = exceptionEvidenceHistory(db);
      const accepted = acceptedLegacyRows(db);
      const audits = db.prepare("SELECT * FROM source_processor_exception_audits").all();
      for (const reapply of [false, true]) {
        if (reapply) db.exec(readFileSync(EXCEPTION_AUDIT_MIGRATION, "utf8"));
        for (const sql of [
          "UPDATE source_processor_exception_audits SET request_json='{}'",
          "DELETE FROM source_processor_exception_audits",
          "INSERT OR REPLACE INTO source_processor_exception_audits SELECT * FROM source_processor_exception_audits",
          "INSERT OR IGNORE INTO source_processor_exception_audits SELECT * FROM source_processor_exception_audits",
        ])
          expect(() => db.exec(sql)).toThrow(/source_processor_evidence_immutable/);
        expect(db.prepare("SELECT * FROM source_processor_exception_audits").all()).toEqual(audits);
        expect(exceptionEvidenceHistory(db)).toEqual(history);
        expect(acceptedLegacyRows(db)).toEqual(accepted);
      }
    },
  );

  it.each([
    {
      field: "request_json",
      exceptionId: EXCEPTION_ID,
      request: "not-json",
      createdAt: EXCEPTION_AT,
      constraint: /CHECK constraint/,
    },
    {
      field: "request_json",
      exceptionId: EXCEPTION_ID,
      request: null,
      createdAt: EXCEPTION_AT,
      constraint: /NOT NULL constraint/,
    },
    {
      field: "created_at",
      exceptionId: EXCEPTION_ID,
      request: "{}",
      createdAt: null,
      constraint: /NOT NULL constraint/,
    },
    {
      field: "exception_id",
      exceptionId: "00000000-0000-4000-8000-000000000099",
      request: "{}",
      createdAt: EXCEPTION_AT,
      constraint: /FOREIGN KEY constraint/,
    },
  ])(
    "rejects an invalid new audit $field without changing historical exceptions",
    ({ exceptionId, request, createdAt, constraint }) => {
      const db = legacyDatabase(19);
      seedExceptionHistory(db, "staging");
      const history = exceptionEvidenceHistory(db);
      const accepted = acceptedLegacyRows(db);
      expect(() =>
        db
          .prepare(
            "INSERT INTO source_processor_exception_audits(exception_id,request_json,created_at) VALUES(?,?,?)",
          )
          .run(exceptionId, request, createdAt),
      ).toThrow(constraint);
      expect(db.prepare("SELECT * FROM source_processor_exception_audits").all()).toEqual([]);
      expect(exceptionEvidenceHistory(db)).toEqual(history);
      expect(acceptedLegacyRows(db)).toEqual(accepted);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );
});
