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
const TARGET_ORIGIN = "00000000-0000-4000-8000-000000000001";
const TARGET_RECOVERY = "00000000-0000-4000-8000-000000000002";
const TARGET_CLAIM = "00000000-0000-4000-8000-000000000004";
const TARGET_HISTORY_TABLES = [
  "source_queue",
  "source_processing_claims",
  "source_processor_state",
  "source_processor_runs",
  "source_processor_item_bindings",
  "source_processor_incidents",
  "source_processor_incident_heads",
  "source_processor_detail_settlements",
];

function seedTargetHistory(db: DatabaseSync, environment: "staging" | "production") {
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`INSERT INTO source_queue(source,item_id,url,title,published_at,official,status,review_generation,attempts,first_seen_at,updated_at)
    VALUES('naver-board-56','1800','https://game.naver.com/1800','Preserved current target','2026-10-01T00:00:00Z',1,'pending',4,2,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
    INSERT INTO source_processing_claims(source,item_id,claim_token,lease_until,source_generation,consecutive_failures)
    VALUES('naver-board-56','1800','${TARGET_CLAIM}','2026-10-01T01:00:00Z',4,1);
    INSERT INTO source_processor_state(singleton_id,epoch,state,failure_count,failed_scope,failed_source,failed_item_id,failed_generation,updated_at)
    VALUES(1,1,'held',3,'detail','naver-board-56','1800',1,'2026-10-01T00:00:00Z');`);
  const insertRun =
    db.prepare(`INSERT INTO source_processor_runs(token,epoch,kind,environment,status,started_at,lease_until,scope)
    VALUES(?,1,?, ?,?,'2026-10-01T00:00:00Z','2026-10-01T01:00:00Z','detail')`);
  insertRun.run(TARGET_ORIGIN, "normal", environment, "failure");
  insertRun.run(TARGET_RECOVERY, "recovery", environment, "running");
  db.prepare(`INSERT INTO source_processor_incidents(origin_run_token,epoch,scope,source,item_id,source_generation,item_claim_token,outcome,error_code,created_at)
    VALUES(?,1,'detail','naver-board-56','1800',1,'00000000-0000-4000-8000-000000000003','failure','source_processor_detail_unavailable','2026-10-01T00:00:00Z')`).run(
    TARGET_ORIGIN,
  );
  db.prepare("INSERT INTO source_processor_incident_heads(epoch,origin_run_token) VALUES(1,?)").run(
    TARGET_ORIGIN,
  );
  db.prepare(`INSERT INTO source_processor_item_bindings(run_token,source,item_id,item_claim_token,source_generation,settled,validated)
    VALUES(?,'naver-board-56','1800','00000000-0000-4000-8000-000000000003',1,1,0)`).run(
    TARGET_ORIGIN,
  );
  db.prepare(`INSERT INTO source_processor_detail_settlements(run_token,source,item_id,source_generation,item_claim_token,result_token,outcome,validated,metadata_json,created_at)
    VALUES(?,'naver-board-56','1800',1,'00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000005','retry',0,'{"generation":1}','2026-10-01T00:00:00Z')`).run(
    TARGET_ORIGIN,
  );
}

function insertTargetReservation(db: DatabaseSync) {
  db.prepare(`INSERT INTO source_processor_target_reservations VALUES(
    ?,'target-request',?,'naver-board-56','1800',4,?,'{"generation":4}',?,?,'2026-10-01T00:00:00Z','2026-10-01T01:00:00Z')`).run(
    TARGET_RECOVERY,
    TARGET_ORIGIN,
    TARGET_CLAIM,
    "b".repeat(64),
    "d".repeat(64),
  );
}

function targetEvidenceHistory(db: DatabaseSync) {
  return TARGET_HISTORY_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
}

const EXCEPTION_AUDIT_MIGRATION = resolve(
  root,
  "forecast-collector/migrations/0019_source_processor_exception_audits.sql",
);
const EXCEPTION_ID = "00000000-0000-4000-8000-000000000007";
const EXCEPTION_AT = "2026-10-01T00:00:00Z";
const EXCEPTION_PROOF = "00000000-0000-4000-8000-000000000006";

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

function seedExceptionHistory(db: DatabaseSync, environment: "staging" | "production") {
  seedTargetHistory(db, environment);
  insertTargetReservation(db);
  db.prepare(`INSERT INTO source_processor_recovery_probes(proof_id,recovery_run_token,request_id,payload_hash,origin_run_token,source,item_id,source_generation,item_claim_token,metadata_json,failed_error_code,response_hash,request_profile_hash,comparable,proof_impossible_reason,created_at)
    VALUES(?,?,'exception-probe',?,?,'naver-board-56','1800',4,?,'{"generation":4}','source_processor_detail_unavailable',?,?,0,'legacy evidence unavailable',?)`).run(
    EXCEPTION_PROOF,
    TARGET_RECOVERY,
    "a".repeat(64),
    TARGET_ORIGIN,
    TARGET_CLAIM,
    "b".repeat(64),
    "c".repeat(64),
    EXCEPTION_AT,
  );
  db.prepare(`INSERT INTO source_processor_item_exceptions(exception_id,proof_id,recovery_run_token,request_id,payload_hash,source,item_id,source_generation,review_generation,review_id,metadata_json,item_claim_token,mode,reason,force_confirmed,created_at)
    VALUES(?, ?,?,'exception-request',?,'naver-board-56','1800',4,4,'retained-review','{"generation":4}',?,'force','Retained historical operator exception',1,?)`).run(
    EXCEPTION_ID,
    EXCEPTION_PROOF,
    TARGET_RECOVERY,
    "d".repeat(64),
    TARGET_CLAIM,
    EXCEPTION_AT,
  );
}

function insertExceptionAudit(db: DatabaseSync) {
  db.prepare(
    "INSERT INTO source_processor_exception_audits(exception_id,request_json,created_at) VALUES(?,?,?)",
  ).run(
    EXCEPTION_ID,
    JSON.stringify({
      requestId: "exception-request",
      proofId: EXCEPTION_PROOF,
      mode: "force",
      reason: "Operator reviewed unrecoverable evidence",
      selfDeclaredActor: "migration-test-operator",
      authenticatedCredentialType: "shared_admin_token",
      actorIdentityVerified: false,
    }),
    EXCEPTION_AT,
  );
}

function exceptionEvidenceHistory(db: DatabaseSync) {
  return [
    ...TARGET_HISTORY_TABLES,
    "source_processor_target_reservations",
    "source_processor_recovery_receipts",
    "source_processor_control_reservations",
    "source_processor_control_results",
    "source_processor_recovery_probes",
    "source_processor_item_exceptions",
    "source_processor_exception_resolutions",
    "source_processor_proof_invalidations",
  ].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
}

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
