import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  applyForecastD1Migrations,
  discoverForecastMigrations,
  parseMigrationArguments,
} from "./apply-forecast-d1-migrations.ts";
import {
  acceptedLegacyRows,
  assertLegacyBaseline,
  currentVersions,
  database,
  fixtureDirectory,
  json,
  ledgerRows,
  legacyDatabase,
  localStaging,
  migrations,
  result,
  root,
  type Spawn,
  sqliteRunner,
} from "./forecast-migration-test-fixtures.ts";

function databaseSnapshot(db: DatabaseSync) {
  const catalog = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const tables = catalog.filter((row) => row["type"] === "table");
  return {
    catalog,
    rows: Object.fromEntries(
      tables.map((row) => [
        String(row["name"]),
        db.prepare(`SELECT * FROM "${String(row["name"])}"`).all(),
      ]),
    ),
  };
}

describe("Forecast migration discovery and CLI", () => {
  it("discovers current incremental files 0002..0021 in numeric order", () => {
    expect(migrations.map((migration) => migration.version)).toEqual(currentVersions.slice(1));
    expect(migrations.map((migration) => basename(migration.file))).toEqual([
      "0002_collector_deployment_sha.sql",
      "0003_lightweight_source_queue.sql",
      "0004_discord_approval_tests.sql",
      "0005_discord_staging_adoptions.sql",
      "0006_discord_staging_message_identity.sql",
      "0007_workflow_dispatch_ops.sql",
      "0008_manual_reviews_interactions_canary.sql",
      "0009_d1_budget_canary_v6.sql",
      "0010_canary_v10_version_identity.sql",
      "0011_source_processing_and_refresh.sql",
      "0012_staging_adoption_attempt_leases.sql",
      "0013_source_metadata_and_adoption_infrastructure.sql",
      "0014_source_processor_failure_budget.sql",
      "0015_staging_adoption_recovery_clock.sql",
      "0016_dispatcher_retry_budget.sql",
      "0017_source_processor_incident_evidence.sql",
      "0018_source_processor_target_reservations.sql",
      "0019_source_processor_exception_audits.sql",
      "0020_source_poll_recovery_audits.sql",
      "0021_source_poll_marker_recovery_audits.sql",
    ]);
    expect(migrations.at(-1)?.file).toBe(
      resolve(root, "forecast-collector/migrations/0021_source_poll_marker_recovery_audits.sql"),
    );
  });

  it("sorts discovered files and ignores documentation", () => {
    const path = fixtureDirectory(["0003_third.sql", "README.md", "0002_second.sql"]);
    expect(discoverForecastMigrations(path).map((migration) => migration.version)).toEqual([2, 3]);
  });

  it.each(
    [
      [],
      ["0001_bootstrap.sql"],
      ["2_short.sql"],
      ["0002_bad-name.sql"],
      ["0002_upper.SQL"],
      ["0002_second.sql", "0002_duplicate.sql"],
      ["0002_second.sql", "0004_gap.sql"],
    ].map((names) => ({ names })),
  )("rejects an invalid migration inventory: $names", ({ names }) => {
    expect(() => discoverForecastMigrations(fixtureDirectory(names))).toThrow();
  });

  it("rejects a directory masquerading as a SQL file before spawning Wrangler", () => {
    const path = fixtureDirectory([]);
    mkdirSync(join(path, "forecast-collector", "migrations", "0002_directory.sql"), {
      recursive: true,
    });
    const spawn = vi.fn<Spawn>();
    expect(() => applyForecastD1Migrations(localStaging, { root: path, spawn })).toThrow(
      /filename/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("requires an explicit environment and target, with local-only persistence", () => {
    expect(
      parseMigrationArguments(["--env", "staging", "--local", "--persist-to", "state"]),
    ).toEqual({
      ...localStaging,
      persistTo: "state",
    });
    expect(parseMigrationArguments(["--env=production", "--remote"])).toEqual({
      environment: "production",
      local: false,
    });
  });

  it.each(
    [
      [],
      ["--remote"],
      ["--env=", "--remote"],
      ["--env=preview", "--remote"],
      ["--env=staging"],
      ["--env=staging", "--local", "--remote"],
      ["--env=staging", "--remote", "--persist-to=state"],
      ["--env=staging", "--local", "--persist-to="],
      ["--env=staging", "--env=production", "--remote"],
      ["--env=staging", "--remote", "--config=other.toml"],
    ].map((args) => ({ args })),
  )("rejects ambiguous or unsupported arguments: $args", ({ args }) => {
    expect(() => parseMigrationArguments(args)).toThrow();
  });

  it("fails at the real Node CLI entrypoint without invoking Wrangler when no target is given", () => {
    const process = spawnSync(
      globalThis.process.execPath,
      ["scripts/apply-forecast-d1-migrations.ts"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
    expect(process.status).toBe(1);
    expect(process.stderr).toContain("explicit --env");
    expect(process.stdout).toBe("");
  });
});

describe("Forecast migration SQL and restart behavior", () => {
  it.each(["staging", "production"] as const)(
    "bootstraps a clean %s DB once, without replaying ALTER migrations",
    (environment) => {
      const db = database();
      // D1/SQLite internal tables do not turn a new database into an unledgered application DB.
      db.exec("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value TEXT);");
      const runner = sqliteRunner(db);
      expect(runner.run({ environment, local: true })).toEqual({
        bootstrapped: true,
        applied: [],
        versions: currentVersions,
      });
      expect(runner.files()).toEqual(["schema.sql"]);
      const columns = db.prepare("PRAGMA table_info(canary_runs)").all();
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "collector_version_id", notnull: 1 }),
          expect.objectContaining({ name: "dispatcher_version_id", notnull: 1 }),
        ]),
      );
      runner.spawn.mockClear();
      expect(runner.run({ environment, local: true })).toEqual({
        bootstrapped: false,
        applied: [],
        versions: currentVersions,
      });
      expect(runner.files()).toEqual([]);
    },
  );

  it("upgrades real v1 SQL through 21 and leaves completed migrations untouched on restart", () => {
    const db = legacyDatabase(1);
    const accepted = acceptedLegacyRows(db);
    const runner = sqliteRunner(db);
    expect(runner.run().applied).toEqual(currentVersions.slice(1));
    expect(runner.files()).toEqual(migrations.map((migration) => basename(migration.file)));
    expect(db.prepare("SELECT deployment_sha FROM collector_runs WHERE id = 1").get()).toEqual({
      deployment_sha: "legacy",
    });
    // 0010 intentionally adds nullable columns on upgrade; bootstrap has stronger new-row constraints.
    expect(db.prepare("PRAGMA table_info(canary_runs)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "collector_version_id", notnull: 0 }),
      ]),
    );
    const baseline = assertLegacyBaseline(db, accepted);
    const before = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    runner.spawn.mockClear();
    expect(runner.run().applied).toEqual([]);
    expect(runner.files()).toEqual([]);
    expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(before);
    expect(assertLegacyBaseline(db, accepted)).toEqual(baseline);
  });

  it.each([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])(
    "resumes an existing staging ledger at version %i",
    (version) => {
      const runner = sqliteRunner(legacyDatabase(version));
      expect(runner.run().applied).toEqual(
        currentVersions.filter((candidate) => candidate > version),
      );
    },
  );

  it("upgrades v10 to 21 preserving accepted facts and cursors, then performs only reads", () => {
    const db = legacyDatabase(10);
    db.exec(`INSERT INTO source_poll_state(source,committed_item_id,committed_published_at,
      scan_head_item_id,scan_head_published_at,next_offset,updated_at) VALUES
      ('naver-board-56','100','2026-09-18T08:00:36.000Z','101','2026-09-19T08:00:36.000Z',
       88,'2026-09-30T03:00:00.000Z');`);
    const before = databaseSnapshot(db);
    const runner = sqliteRunner(db);
    expect(runner.run()).toEqual({
      bootstrapped: false,
      applied: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
      versions: currentVersions,
    });
    expect(runner.files()).toEqual(
      migrations
        .filter((migration) => migration.version >= 11)
        .map((migration) => basename(migration.file)),
    );
    const after = databaseSnapshot(db);
    for (const [table, rows] of Object.entries(before.rows)) {
      if (table === "schema_migrations") continue;
      expect(after.rows[table]).toEqual(rows);
    }
    expect(
      db.prepare("SELECT * FROM schema_migrations WHERE version <= 10 ORDER BY version").all(),
    ).toEqual(before.rows["schema_migrations"]);
    const baseline = db.prepare("SELECT * FROM source_legacy_event_baselines").get();
    expect(baseline).toMatchObject({ event_id: "event-1", body_available: 0 });
    const source = JSON.parse(String(baseline?.["source_json"]));
    expect(source).toMatchObject({
      contentHash: "c".repeat(64),
      excerpt: "retained excerpt; full body unavailable",
      publishedAt: "2026-09-18T08:00:36.000Z",
    });
    expect(source).not.toHaveProperty("normalizedText");
    expect(JSON.parse(String(baseline?.["event_json"]))).toMatchObject({
      startsAt: "2026-09-24T03:00:00.000Z",
      endsAt: "2026-09-30T19:59:00.000Z",
      scheduleStatus: "confirmed",
    });
    expect(db.prepare("SELECT * FROM source_notice_revisions").all()).toEqual([]);
    for (const sql of [
      "UPDATE source_legacy_event_baselines SET source_json='{}'",
      "DELETE FROM source_legacy_event_baselines",
      "INSERT OR REPLACE INTO source_legacy_event_baselines SELECT * FROM source_legacy_event_baselines",
      "INSERT OR IGNORE INTO source_legacy_event_baselines SELECT * FROM source_legacy_event_baselines",
    ]) {
      expect(() => db.exec(sql)).toThrow(/source_evidence_immutable/);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const completed = databaseSnapshot(db);
    runner.spawn.mockClear();
    expect(runner.run()).toEqual({ bootstrapped: false, applied: [], versions: currentVersions });
    expect(runner.files()).toEqual([]);
    expect(runner.spawn).toHaveBeenCalledTimes(2);
    for (const [, args] of runner.spawn.mock.calls) {
      expect(args[args.indexOf("--command") + 1]).toMatch(/^SELECT /);
    }
    expect(databaseSnapshot(db)).toEqual(completed);
  });

  it("preserves v8 reviews and creates immutable v11 evidence bindings exactly once", () => {
    const db = legacyDatabase(7);
    db.exec(`INSERT INTO source_queue (source, item_id, url, title, published_at, official, status,
      first_seen_at, updated_at) VALUES ('naver-board-56', '1', 'https://example.test/1', 'test',
      '2026-09-01T00:00:00Z', 1, 'manual_review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');`);
    db.prepare(`INSERT INTO source_items VALUES ('naver-board-56', '1',
      'https://example.test/1', 'test', 'retained official body', '2026-09-01T00:00:00Z',
      ?, 0, 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run("a".repeat(64));
    const runner = sqliteRunner(db);
    expect(runner.run().applied).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    const reviews = db.prepare("SELECT * FROM source_manual_reviews").all();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      generation: 0,
      state: "pending",
      expires_at: "2026-09-15T00:00:00.000Z",
    });
    const bindings = db.prepare("SELECT * FROM source_manual_review_bindings").all();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      review_id: reviews[0]?.["review_id"],
      source_revision: 0,
      body_hash: "a".repeat(64),
      revision_hash: null,
      semantic_hash: null,
      generation: 0,
      review_token: expect.stringMatching(/^[0-9a-f]{64}$/),
      item_json: null,
    });
    expect(JSON.parse(String(bindings[0]?.["metadata_json"]))).toEqual({
      source: "naver-board-56",
      itemId: "1",
      url: "https://example.test/1",
      title: "test",
      publishedAt: "2026-09-01T00:00:00Z",
      official: 1,
    });
    expect(() => db.exec("UPDATE source_manual_review_bindings SET generation=1")).toThrow(
      /source_evidence_immutable/,
    );
    runner.run();
    expect(db.prepare("SELECT * FROM source_manual_reviews").all()).toEqual(reviews);
    expect(db.prepare("SELECT * FROM source_manual_review_bindings").all()).toEqual(bindings);
  });
});

describe("REVIEW11 create-only forecast storage upgrade", () => {
  it.each(["staging", "production"] as const)(
    "upgrades v12 %s to create-only metadata and infrastructure storage without changing accepted facts",
    (environment) => {
      const db = legacyDatabase(12, environment === "production");
      const accepted = acceptedLegacyRows(db);
      db.exec(`INSERT INTO source_poll_state(source,next_offset,updated_at) VALUES('naver-board-56',8,'2026-10-01T00:00:00Z');
        INSERT INTO source_queue(source,item_id,url,title,published_at,official,status,review_generation,first_seen_at,updated_at)
        VALUES('naver-board-56','901','https://game.naver.com/901','Solo season requires review','2026-10-01T00:00:00Z',1,'manual_review',3,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');`);
      const queue = db.prepare("SELECT * FROM source_queue").all();
      const polls = db.prepare("SELECT * FROM source_poll_state").all();
      const runner = sqliteRunner(db);
      expect(runner.run({ environment, local: true }).applied).toEqual([
        13, 14, 15, 16, 17, 18, 19, 20, 21,
      ]);
      expect(runner.files()).toEqual([
        "0013_source_metadata_and_adoption_infrastructure.sql",
        "0014_source_processor_failure_budget.sql",
        "0015_staging_adoption_recovery_clock.sql",
        "0016_dispatcher_retry_budget.sql",
        "0017_source_processor_incident_evidence.sql",
        "0018_source_processor_target_reservations.sql",
        "0019_source_processor_exception_audits.sql",
        "0020_source_poll_recovery_audits.sql",
        "0021_source_poll_marker_recovery_audits.sql",
      ]);
      for (const table of [
        "source_metadata_observations",
        "source_poll_scan_status",
        "staging_adoption_infrastructure_circuit",
      ]) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
        expect(db.prepare(`PRAGMA foreign_key_check(${table})`).all()).toEqual([]);
      }
      expect(db.prepare("SELECT * FROM source_queue").all()).toEqual(queue);
      expect(db.prepare("SELECT * FROM source_poll_state").all()).toEqual(polls);
      expect(acceptedLegacyRows(db)).toEqual(accepted);
      db.prepare(
        "INSERT INTO source_metadata_observations VALUES('naver-board-56','901',?,3,1,'2026-10-01T00:00:00Z')",
      ).run("a".repeat(64));
      db.exec(
        "INSERT INTO source_poll_scan_status VALUES('naver-board-56',1,'2026-10-01T00:00:00Z'); INSERT INTO staging_adoption_infrastructure_circuit(singleton_id,state,attempts,first_failed_at,updated_at) VALUES(1,'retry',0,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');",
      );
      for (const sql of [
        "UPDATE source_metadata_observations SET metadata_hash='bad'",
        "UPDATE source_metadata_observations SET invalid=2",
        "UPDATE source_poll_scan_status SET scan_uncertain=2",
        "UPDATE staging_adoption_infrastructure_circuit SET attempts=9",
        "UPDATE staging_adoption_infrastructure_circuit SET state='unknown'",
        "UPDATE staging_adoption_infrastructure_circuit SET probe_lease_until='2026-10-01T01:00:00Z'",
      ])
        expect(() => db.exec(sql)).toThrow(/CHECK constraint/);
      const observed = db.prepare("SELECT * FROM source_metadata_observations").all();
      const circuit = db.prepare("SELECT * FROM staging_adoption_infrastructure_circuit").all();
      runner.run({ environment, local: true });
      db.exec(
        readFileSync(
          migrations.find((migration) => migration.version === 13)?.file as string,
          "utf8",
        ),
      );
      expect(db.prepare("SELECT * FROM source_queue").all()).toEqual(queue);
      expect(acceptedLegacyRows(db)).toEqual(accepted);
      expect(db.prepare("SELECT * FROM source_metadata_observations").all()).toEqual(observed);
      expect(db.prepare("SELECT * FROM staging_adoption_infrastructure_circuit").all()).toEqual(
        circuit,
      );
      expect(runner.files()).toHaveLength(9);
    },
  );
});

describe("source-processor durable failure-budget storage", () => {
  it.each(["staging", "production"] as const)(
    "upgrades v13 %s without changing accepted evidence or pending per-item claims",
    (environment) => {
      const db = legacyDatabase(13, environment === "production");
      db.exec("PRAGMA foreign_keys=ON");
      const accepted = acceptedLegacyRows(db);
      db.exec(`INSERT INTO source_queue(source,item_id,url,title,published_at,official,status,review_generation,attempts,first_seen_at,updated_at)
        VALUES('naver-board-56','998','https://game.naver.com/998','Preserved source','2026-10-01T00:00:00Z',1,'pending',2,2,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
        INSERT INTO source_processing_claims(source,item_id,claim_token,lease_until,source_generation,consecutive_failures)
        VALUES('naver-board-56','998','00000000-0000-4000-8000-000000000998','2026-10-01T01:00:00Z',2,1);`);
      const queue = db.prepare("SELECT * FROM source_queue").all();
      const claims = db.prepare("SELECT * FROM source_processing_claims").all();
      const runner = sqliteRunner(db);
      expect(runner.run({ environment, local: true }).applied).toEqual([
        14, 15, 16, 17, 18, 19, 20, 21,
      ]);
      expect(runner.files()).toEqual([
        "0014_source_processor_failure_budget.sql",
        "0015_staging_adoption_recovery_clock.sql",
        "0016_dispatcher_retry_budget.sql",
        "0017_source_processor_incident_evidence.sql",
        "0018_source_processor_target_reservations.sql",
        "0019_source_processor_exception_audits.sql",
        "0020_source_poll_recovery_audits.sql",
        "0021_source_poll_marker_recovery_audits.sql",
      ]);
      for (const table of [
        "source_processor_state",
        "source_processor_runs",
        "source_processor_item_bindings",
      ]) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
        expect(db.prepare(`PRAGMA foreign_key_check(${table})`).all()).toEqual([]);
      }
      const token = "00000000-0000-4000-8000-000000000014";
      db.prepare(`INSERT INTO source_processor_state(singleton_id,epoch,state,failure_count,last_error_code,failed_scope,updated_at)
        VALUES(1,1,'retry',1,'source_processor_expired','detail','2026-10-01T00:00:00Z')`).run();
      db.prepare(`INSERT INTO source_processor_runs(token,epoch,kind,status,started_at,lease_until,finished_at,scope,error_code)
        VALUES(?,1,'normal','expired','2026-10-01T00:00:00Z','2026-10-01T00:10:00Z','2026-10-01T00:10:00Z','detail','source_processor_expired')`).run(
        token,
      );
      db.prepare(`INSERT INTO source_processor_item_bindings(run_token,source,item_id,item_claim_token,source_generation)
        VALUES(?,'naver-board-56','998',?,2)`).run(token, token);
      for (const sql of [
        "UPDATE source_processor_state SET failure_count=4",
        "UPDATE source_processor_state SET epoch=0",
        "UPDATE source_processor_state SET state='unknown'",
        "UPDATE source_processor_state SET lease_until='2026-10-01T00:10:00Z'",
        "UPDATE source_processor_runs SET token='bad'",
        "UPDATE source_processor_runs SET resumed_at='2026-10-01T00:10:00Z'",
        "UPDATE source_processor_item_bindings SET validated=1,settled=0",
      ])
        expect(() => db.exec(sql)).toThrow(/CHECK constraint/);
      expect(() =>
        db.exec(
          "UPDATE source_processor_item_bindings SET run_token='00000000-0000-4000-8000-000000000999'",
        ),
      ).toThrow(/FOREIGN KEY constraint/);
      const history = [
        "source_processor_state",
        "source_processor_runs",
        "source_processor_item_bindings",
      ].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      runner.run({ environment, local: true });
      db.exec(readFileSync(migrations.find((m) => m.version === 14)?.file as string, "utf8"));
      expect(acceptedLegacyRows(db)).toEqual(accepted);
      expect(db.prepare("SELECT * FROM source_queue").all()).toEqual(queue);
      expect(db.prepare("SELECT * FROM source_processing_claims").all()).toEqual(claims);
      expect(
        ["source_processor_state", "source_processor_runs", "source_processor_item_bindings"].map(
          (table) => db.prepare(`SELECT * FROM ${table}`).all(),
        ),
      ).toEqual(history);
      expect(runner.files()).toHaveLength(8);
    },
  );

  it("keeps fresh bootstrap and incremental v14 table definitions equal", () => {
    const incremental = legacyDatabase(14);
    const fresh = database();
    fresh.exec(readFileSync(resolve(root, "forecast-collector/schema.sql"), "utf8"));
    for (const table of [
      "source_processor_state",
      "source_processor_runs",
      "source_processor_item_bindings",
    ]) {
      expect(fresh.prepare(`PRAGMA table_info(${table})`).all()).toEqual(
        incremental.prepare(`PRAGMA table_info(${table})`).all(),
      );
      expect(fresh.prepare(`PRAGMA foreign_key_list(${table})`).all()).toEqual(
        incremental.prepare(`PRAGMA foreign_key_list(${table})`).all(),
      );
    }
  });
});

describe("Forecast migration production and fault recovery", () => {
  it.each(["staging", "production"] as const)(
    "upgrades v11 %s with an inert lease table and preserves its existing data on replay",
    (environment) => {
      const db = legacyDatabase(11, environment === "production");
      const accepted = acceptedLegacyRows(db);
      db.exec(
        "INSERT INTO staging_adoption_processing VALUES ('retained-old-attempt','retry',7,'2026-10-01T00:00:00Z','retained_failure','2026-09-30T00:00:00Z')",
      );
      const processing = db.prepare("SELECT * FROM staging_adoption_processing").all();
      const runner = sqliteRunner(db);
      expect(runner.run({ environment, local: true }).applied).toEqual([
        12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      ]);
      expect(runner.files()).toEqual([
        "0012_staging_adoption_attempt_leases.sql",
        "0013_source_metadata_and_adoption_infrastructure.sql",
        "0014_source_processor_failure_budget.sql",
        "0015_staging_adoption_recovery_clock.sql",
        "0016_dispatcher_retry_budget.sql",
        "0017_source_processor_incident_evidence.sql",
        "0018_source_processor_target_reservations.sql",
        "0019_source_processor_exception_audits.sql",
        "0020_source_poll_recovery_audits.sql",
        "0021_source_poll_marker_recovery_audits.sql",
      ]);
      expect(
        db
          .prepare("PRAGMA table_info(staging_adoption_attempt_leases)")
          .all()
          .map((column) => column["name"]),
      ).toEqual([
        "approval_id",
        "lease_token",
        "attempt",
        "state",
        "lease_until",
        "outcome",
        "created_at",
        "settled_at",
      ]);
      expect(db.prepare("PRAGMA foreign_key_check(staging_adoption_attempt_leases)").all()).toEqual(
        [],
      );
      expect(db.prepare("SELECT * FROM staging_adoption_processing").all()).toEqual(processing);
      expect(acceptedLegacyRows(db)).toEqual(accepted);
      if (environment === "production") {
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name IN ('discord_approval_tests','discord_staging_adoptions')",
            )
            .all(),
        ).toEqual([]);
        expect(
          db.prepare("SELECT version FROM schema_migrations WHERE version IN (4,5,6)").all(),
        ).toEqual([]);
      }
      runner.spawn.mockClear();
      expect(runner.run({ environment, local: true }).applied).toEqual([]);
      expect(runner.files()).toEqual([]);
      expect(db.prepare("SELECT * FROM staging_adoption_processing").all()).toEqual(processing);
    },
  );

  it("preserves production's optional 4..6 omission and does not install Discord tables", () => {
    const db = legacyDatabase(7, true);
    const runner = sqliteRunner(db);
    expect(runner.run({ environment: "production", local: false })).toEqual({
      bootstrapped: false,
      applied: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
      versions: [1, 2, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    });
    expect(runner.files()).toEqual(
      migrations
        .filter((migration) => migration.version >= 8)
        .map((migration) => basename(migration.file)),
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'discord_staging_%'").all(),
    ).toEqual([]);
    for (const [command, args, options] of runner.spawn.mock.calls) {
      expect(command).toBe(process.execPath);
      expect(args).toEqual(
        expect.arrayContaining([
          resolve(root, "node_modules/wrangler/bin/wrangler.js"),
          "FORECAST_DB",
          "--remote",
          "--env=",
          "--config",
          resolve(root, "forecast-collector/wrangler.toml"),
          "--yes",
          "--json",
        ]),
      );
      expect(args).not.toContain("--local");
      expect(options).toMatchObject({
        cwd: root,
        timeout: 120_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  });

  it("passes staging and local persistence explicitly to every subprocess", () => {
    const runner = sqliteRunner(legacyDatabase(9));
    runner.run({ ...localStaging, persistTo: "path with spaces" });
    for (const [, args] of runner.spawn.mock.calls) {
      expect(args).toEqual(
        expect.arrayContaining(["--local", "--env=staging", "--persist-to", "path with spaces"]),
      );
      expect(args).not.toContain("--remote");
    }
  });

  it.each([[4], [5], [5, 6], [4, 5, 6]].map((optional) => ({ optional })))(
    "accepts independent optional production seeds already in the ledger: $optional",
    ({ optional }) => {
      const db = legacyDatabase(7, true);
      for (const migration of migrations.filter((migration) =>
        optional.includes(migration.version),
      )) {
        db.exec(readFileSync(migration.file, "utf8"));
      }
      const runner = sqliteRunner(db);
      expect(runner.run({ environment: "production", local: true }).applied).toEqual([
        8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      ]);
      expect(runner.files()).toHaveLength(14);
    },
  );

  it("stops on a failed ALTER without marking or attempting later versions, then resumes", () => {
    const runner = sqliteRunner(legacyDatabase(5));
    const normal = runner.spawn.getMockImplementation() as Spawn;
    runner.spawn.mockImplementation((command, args, options) =>
      args.some((arg) => arg.endsWith("0006_discord_staging_message_identity.sql"))
        ? result("", { status: 1, stderr: "synthetic failure" })
        : normal(command, args, options),
    );
    expect(() => runner.run()).toThrow(/Wrangler D1 --file failed/);
    expect(runner.files()).toEqual(["0006_discord_staging_message_identity.sql"]);
    runner.spawn.mockImplementation(normal);
    expect(runner.run().applied).toEqual([
      6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
  });

  it("resumes from the ledger when SQL committed but its subprocess reported failure", () => {
    const runner = sqliteRunner(legacyDatabase(5));
    const normal = runner.spawn.getMockImplementation() as Spawn;
    runner.spawn.mockImplementation((command, args, options) => {
      const response = normal(command, args, options);
      return args.includes("--file")
        ? result("", { status: 1, stderr: "response lost" })
        : response;
    });
    expect(() => runner.run()).toThrow(/response lost/);
    expect(runner.files()).toEqual(["0006_discord_staging_message_identity.sql"]);
    runner.spawn.mockImplementation(normal).mockClear();
    expect(runner.run().applied).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(runner.files()).not.toContain("0006_discord_staging_message_identity.sql");
  });
});

describe("Forecast migration fail-closed checks", () => {
  it("refuses duplicate v10 candidate revisions before writes and preserves both rows", () => {
    const db = legacyDatabase(10);
    const insert = db.prepare(`INSERT INTO forecast_candidates VALUES
      (?, 'supply-fixture-v1', 'event-1', '2026-09-30', 1, 'x_unavailable', 'observed', '{}', ?,
       '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z')`);
    insert.run("candidate-a", "a".repeat(64));
    insert.run("candidate-b", "b".repeat(64));
    const before = databaseSnapshot(db);
    const runner = sqliteRunner(db);
    expect(() => runner.run()).toThrow(/duplicate_candidate_revision_preflight/);
    expect(runner.files()).toEqual([]);
    expect(databaseSnapshot(db)).toEqual(before);
  });

  it.each(["staging", "production"] as const)(
    "rejects a contiguous unknown version 22 in %s before writes",
    (environment) => {
      const spawn = vi
        .fn<Spawn>()
        .mockReturnValueOnce(result(json([{ name: "schema_migrations", type: "table" }])))
        .mockReturnValueOnce(result(json(ledgerRows([...currentVersions, 22]))));
      expect(() => applyForecastD1Migrations({ environment, local: true }, { spawn })).toThrow(
        "Unknown schema_migrations version: 22",
      );
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls.every(([, args]) => !args.includes("--file"))).toBe(true);
    },
  );

  it.each(
    [
      [],
      [2],
      [1, 3],
      [1, 2, 2],
      [2, 1],
      [1, "2"],
      [1, 2.5],
      [1, null],
      [0],
      [-1],
      [1, 11],
      [1, 9007199254740992],
      [1, 2, 3, 5],
    ].map((versions) => ({ versions })),
  )(
    "rejects a bad, gapped, unordered or unknown ledger without writing: $versions",
    ({ versions }) => {
      const spawn = vi
        .fn<Spawn>()
        .mockReturnValueOnce(result(json([{ name: "schema_migrations", type: "table" }])))
        .mockReturnValue(result(json(ledgerRows(versions))));
      expect(() => applyForecastD1Migrations(localStaging, { spawn })).toThrow(/ledger|version/);
      expect(spawn.mock.calls.every(([, args]) => !args.includes("--file"))).toBe(true);
    },
  );

  it.each(["staging", "production"] as const)("rejects required gaps in %s", (environment) => {
    const spawn = vi
      .fn<Spawn>()
      .mockReturnValueOnce(result(json([{ name: "schema_migrations", type: "table" }])))
      .mockReturnValue(result(json(ledgerRows([1, 2, 3, 7, 9]))));
    expect(() => applyForecastD1Migrations({ environment, local: true }, { spawn })).toThrow(/Gap/);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("rejects production version 6 without its version 5 prerequisite", () => {
    const spawn = vi
      .fn<Spawn>()
      .mockReturnValueOnce(result(json([{ name: "schema_migrations", type: "table" }])))
      .mockReturnValue(result(json(ledgerRows([1, 2, 3, 6, 7]))));
    expect(() =>
      applyForecastD1Migrations({ environment: "production", local: true }, { spawn }),
    ).toThrow(/missing version 5/);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each([null, "", " ", 123])("rejects malformed ledger timestamps: %j", (applied_at) => {
    const spawn = vi
      .fn<Spawn>()
      .mockReturnValueOnce(result(json([{ name: "schema_migrations", type: "table" }])))
      .mockReturnValue(result(json([{ version: 1, applied_at }])));
    expect(() => applyForecastD1Migrations(localStaging, { spawn })).toThrow(/ledger/);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each([
    "CREATE TABLE existing_data (id INTEGER)",
    "CREATE VIEW schema_migrations AS SELECT 1 AS version",
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    "CREATE TABLE schema_migrations (wrong_column INTEGER)",
  ])("never bootstraps a missing, empty or broken ledger on existing storage: %s", (sql) => {
    const db = database();
    db.exec(sql);
    const runner = sqliteRunner(db);
    expect(() => runner.run()).toThrow();
    expect(runner.files()).toEqual([]);
  });

  it.each([
    "not json",
    "{}",
    "[]",
    '[{"success":false,"results":[]}]',
    '[{"results":[]}]',
    '[{"success":true,"results":null}]',
    '[{"success":true,"results":[]},{"success":true,"results":[]}]',
    '[{"success":true,"results":[{"name":123,"type":"table"}]}]',
  ])("rejects malformed or unsuccessful Wrangler JSON: %s", (stdout) => {
    const spawn = vi.fn<Spawn>().mockReturnValue(result(stdout));
    expect(() => applyForecastD1Migrations(localStaging, { spawn })).toThrow(/Wrangler/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 1 },
    { status: null, signal: "SIGTERM" as const },
    { status: null, error: new Error("spawn ENOENT") },
    { status: null, error: new Error("spawn ETIMEDOUT") },
    { status: null, error: new Error("spawn ENOBUFS") },
  ])("propagates subprocess failure without treating it as an empty DB: %j", (failure) => {
    const spawn = vi.fn<Spawn>().mockReturnValue(result(json([]), failure));
    expect(() => applyForecastD1Migrations(localStaging, { spawn })).toThrow(/Wrangler D1/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not trust a zero exit code when the applied version is missing from the reread", () => {
    const runner = sqliteRunner(legacyDatabase(5));
    const normal = runner.spawn.getMockImplementation() as Spawn;
    runner.spawn.mockImplementation((command, args, options) =>
      args.includes("--file") ? result(json([])) : normal(command, args, options),
    );
    expect(() => runner.run()).toThrow(/did not produce the expected ledger/);
    expect(runner.files()).toEqual(["0006_discord_staging_message_identity.sql"]);
  });

  it("stops when the post-apply ledger read fails, without attempting another file", () => {
    const runner = sqliteRunner(legacyDatabase(5));
    const normal = runner.spawn.getMockImplementation() as Spawn;
    let fileApplied = false;
    runner.spawn.mockImplementation((command, args, options) => {
      if (fileApplied) return result("", { status: 1, stderr: "ledger read failed" });
      const response = normal(command, args, options);
      fileApplied = args.includes("--file");
      return response;
    });
    expect(() => runner.run()).toThrow(/ledger read failed/);
    expect(runner.files()).toEqual(["0006_discord_staging_message_identity.sql"]);
  });

  it("rejects an unsuccessful file result even with a zero process exit", () => {
    const runner = sqliteRunner(legacyDatabase(5));
    const normal = runner.spawn.getMockImplementation() as Spawn;
    runner.spawn.mockImplementation((command, args, options) =>
      args.includes("--file")
        ? result('[{"success":false,"results":[]}]')
        : normal(command, args, options),
    );
    expect(() => runner.run()).toThrow(/unsuccessful/);
    expect(runner.files()).toHaveLength(1);
  });

  it("rejects an unexpected ledger change after apply", () => {
    const runner = sqliteRunner(legacyDatabase(5));
    const normal = runner.spawn.getMockImplementation() as Spawn;
    runner.spawn.mockImplementation((command, args, options) => {
      const response = normal(command, args, options);
      if (args.includes("--file")) {
        normal(
          command,
          [
            ...args.slice(0, -2),
            "--file",
            migrations.find((migration) => migration.version === 7)?.file as string,
          ],
          options,
        );
      }
      return response;
    });
    expect(() => runner.run()).toThrow(/expected ledger/);
    expect(runner.files()).toHaveLength(1);
  });

  it("verifies the exact bootstrap ledger, not just a successful file execution", () => {
    const spawn = vi
      .fn<Spawn>()
      .mockReturnValueOnce(result(json([])))
      .mockReturnValueOnce(result(json([])))
      .mockReturnValueOnce(result(json(ledgerRows([1]))));
    expect(() => applyForecastD1Migrations(localStaging, { spawn, log: () => {} })).toThrow(
      /bootstrap.*expected ledger/,
    );
    expect(spawn).toHaveBeenCalledTimes(3);
  });
});
