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
  assertLegacyBaseline,
  database,
  fixtureDirectory,
  localStaging,
  migrations,
  currentVersions as previousVersions,
  result,
  root,
  type Spawn,
  sqliteRunner,
} from "./forecast-migration-test-fixtures.ts";
import { acceptedLegacyRows, legacyDatabase } from "./forecast-migration-v27-fixtures.ts";

const v2Versions = [30, 31, 32, 33, 34];
const v2Files = [
  "0030_monitor_streams.sql",
  "0031_calendar_decisions.sql",
  "0032_grant_occurrences.sql",
  "0033_calendar_snapshots.sql",
  "0034_runtime_publication_v5.sql",
];
const currentVersions = [...previousVersions, 26, 27, 28, 29, ...v2Versions];

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
it("records the v24 latest-ingestion-run index in the migration schema snapshot", () => {
  const db = legacyDatabase(23);
  sqliteRunner(db).run();
  expect(databaseSnapshot(db).catalog).toContainEqual({
    type: "index",
    name: "runtime_ingestion_runs_started_at",
    sql: "CREATE INDEX runtime_ingestion_runs_started_at\n  ON runtime_ingestion_runs(started_at DESC)",
  });
});

describe("Forecast migration discovery and CLI", () => {
  it("rejects a missing environment at the programmatic entrypoint before invoking Wrangler", () => {
    const spawn = vi.fn<Spawn>();
    expect(() =>
      applyForecastD1Migrations(
        { local: true } as Parameters<typeof applyForecastD1Migrations>[0],
        { spawn },
      ),
    ).toThrow("explicit --env");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("discovers current incremental files 0002..0034 in numeric order", () => {
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
      "0022_forecast_runtime_versions.sql",
      "0023_forecast_runtime_publication.sql",
      "0024_runtime_ingestion.sql",
      "0025_naver_page_policy.sql",
      "0026_source_judgment_evidence.sql",
      "0027_board11_grants.sql",
      "0028_publication_exclusions.sql",
      "0029_candidate_replay_cache.sql",
      ...v2Files,
    ]);
    expect(migrations.at(-1)?.file).toBe(
      resolve(root, "forecast-collector/migrations/0034_runtime_publication_v5.sql"),
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
      parseMigrationArguments([
        "--env",
        "staging",
        "--local",
        "--persist-to",
        "state",
        "--allow-forecast-v2",
      ]),
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
        applied: [22, 23, 24, 25, 26, 27, 28, 29, ...v2Versions],
        versions: currentVersions,
      });
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
        ...v2Files,
      ]);
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
  it("upgrades real v1 SQL through 26 and leaves completed migrations untouched on restart", () => {
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

  it.each([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 24])(
    "resumes an existing staging ledger at version %i",
    (version) => {
      const runner = sqliteRunner(legacyDatabase(version));
      expect(runner.run().applied).toEqual(
        currentVersions.filter((candidate) => candidate > version),
      );
    },
  );

  it("upgrades v10 to 26 preserving accepted facts and cursors, then performs only reads", () => {
    const db = legacyDatabase(10);
    db.exec(`INSERT INTO source_poll_state(source,committed_item_id,committed_published_at,
      scan_head_item_id,scan_head_published_at,next_offset,updated_at) VALUES
      ('naver-board-56','100','2026-09-18T08:00:36.000Z','101','2026-09-19T08:00:36.000Z',
       88,'2026-09-30T03:00:00.000Z');`);
    const before = databaseSnapshot(db);
    const runner = sqliteRunner(db);
    expect(runner.run()).toEqual({
      bootstrapped: false,
      applied: [
        11,
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        22,
        23,
        24,
        25,
        26,
        27,
        28,
        29,
        ...v2Versions,
      ],
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
      const addedColumns: Record<string, Record<string, unknown>> = {
        source_poll_state: { page_size: 10 },
        schedule_events: { segment_json: null },
      };
      const expected = rows.map((row) => ({ ...row, ...addedColumns[table] }));
      expect(after.rows[table]).toEqual(expected);
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
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        22,
        23,
        24,
        25,
        26,
        27,
        28,
        29,
        ...v2Versions,
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
        "0022_forecast_runtime_versions.sql",
        "0023_forecast_runtime_publication.sql",
        "0024_runtime_ingestion.sql",
        "0025_naver_page_policy.sql",
        "0026_source_judgment_evidence.sql",
        "0027_board11_grants.sql",
        "0028_publication_exclusions.sql",
        "0029_candidate_replay_cache.sql",
        ...v2Files,
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
      expect(db.prepare("SELECT * FROM source_poll_state").all()).toEqual(
        polls.map((row) => ({ ...row, page_size: 10 })),
      );
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
      expect(runner.files()).toHaveLength(22);
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
        14,
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        22,
        23,
        24,
        25,
        26,
        27,
        28,
        29,
        ...v2Versions,
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
        "0022_forecast_runtime_versions.sql",
        "0023_forecast_runtime_publication.sql",
        "0024_runtime_ingestion.sql",
        "0025_naver_page_policy.sql",
        "0026_source_judgment_evidence.sql",
        "0027_board11_grants.sql",
        "0028_publication_exclusions.sql",
        "0029_candidate_replay_cache.sql",
        ...v2Files,
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
      expect(runner.files()).toHaveLength(21);
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
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        22,
        23,
        24,
        25,
        26,
        27,
        28,
        29,
        ...v2Versions,
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
        "0022_forecast_runtime_versions.sql",
        "0023_forecast_runtime_publication.sql",
        "0024_runtime_ingestion.sql",
        "0025_naver_page_policy.sql",
        "0026_source_judgment_evidence.sql",
        "0027_board11_grants.sql",
        "0028_publication_exclusions.sql",
        "0029_candidate_replay_cache.sql",
        ...v2Files,
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
});

describe("Forecast migration production seed handling", () => {
  it("preserves production's optional 4..6 omission and does not install Discord tables", () => {
    const db = legacyDatabase(7, true);
    const runner = sqliteRunner(db);
    expect(runner.run({ environment: "production", local: false })).toEqual({
      bootstrapped: false,
      applied: [
        8,
        9,
        10,
        11,
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        22,
        23,
        24,
        25,
        26,
        27,
        28,
        29,
        ...v2Versions,
      ],
      versions: [
        1,
        2,
        3,
        7,
        8,
        9,
        10,
        11,
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        22,
        23,
        24,
        25,
        26,
        27,
        28,
        29,
        ...v2Versions,
      ],
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
        8,
        9,
        10,
        11,
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        22,
        23,
        24,
        25,
        26,
        27,
        28,
        29,
        ...v2Versions,
      ]);
      expect(runner.files()).toHaveLength(27);
    },
  );
});

describe("Forecast migration fault recovery", () => {
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
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16,
      17,
      18,
      19,
      20,
      21,
      22,
      23,
      24,
      25,
      26,
      27,
      28,
      29,
      ...v2Versions,
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
    expect(runner.run().applied).toEqual([
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16,
      17,
      18,
      19,
      20,
      21,
      22,
      23,
      24,
      25,
      26,
      27,
      28,
      29,
      ...v2Versions,
    ]);
    expect(runner.files()).not.toContain("0006_discord_staging_message_identity.sql");
  });
});
