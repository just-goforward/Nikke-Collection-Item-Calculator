import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyForecastD1Migrations,
  discoverForecastMigrations,
  parseMigrationArguments,
} from "./apply-forecast-d1-migrations.ts";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, "forecast-collector/migrations");
const migrations = discoverForecastMigrations(directory);
const currentVersions = Array.from({ length: 10 }, (_, index) => index + 1);
const localStaging = { environment: "staging", local: true } as const;
const cleanup: Array<() => void> = [];
type Spawn = NonNullable<NonNullable<Parameters<typeof applyForecastD1Migrations>[1]>["spawn"]>;

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function result(
  stdout: string,
  overrides: Partial<SpawnSyncReturns<string>> = {},
): SpawnSyncReturns<string> {
  return {
    pid: 1,
    status: 0,
    signal: null,
    stdout,
    stderr: "",
    output: [null, stdout, ""],
    ...overrides,
  };
}

function json(rows: unknown[]) {
  return JSON.stringify([{ success: true, results: rows }]);
}

function ledgerRows(versions: unknown[]) {
  return versions.map((version) => ({ version, applied_at: "2026-09-05 00:00:00" }));
}

function fixtureDirectory(names: string[]) {
  const path = mkdtempSync(join(tmpdir(), "forecast-migrations-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  for (const name of names) writeFileSync(join(path, name), "SELECT 1;");
  return path;
}

function database() {
  const db = new DatabaseSync(":memory:");
  cleanup.push(() => db.close());
  return db;
}

function sqliteRunner(db: DatabaseSync) {
  const spawn = vi.fn<Spawn>((_command, args) => {
    try {
      const fileIndex = args.indexOf("--file");
      if (fileIndex >= 0) {
        db.exec(readFileSync(args[fileIndex + 1] as string, "utf8"));
        return result(json([]));
      }
      const sql = args[args.indexOf("--command") + 1] as string;
      return result(json(db.prepare(sql).all()));
    } catch (error) {
      return result("", { status: 1, stderr: String(error) });
    }
  });
  const run = (options = localStaging as Parameters<typeof applyForecastD1Migrations>[0]) =>
    applyForecastD1Migrations(options, { spawn, log: () => {} });
  const files = () =>
    spawn.mock.calls.flatMap(([, args]) => {
      const index = args.indexOf("--file");
      return index < 0 ? [] : [basename(args[index + 1] as string)];
    });
  return { spawn, run, files };
}

function legacyDatabase(version: number, production = false) {
  const db = database();
  // Minimal v1 fixture for the original 0002 ALTER and all subsequent real SQL files.
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, CURRENT_TIMESTAMP);
    CREATE TABLE collector_runs (id INTEGER PRIMARY KEY);
    INSERT INTO collector_runs VALUES (1);`);
  for (const migration of migrations) {
    if (migration.version > version) break;
    if (production && [4, 5, 6].includes(migration.version)) continue;
    db.exec(readFileSync(migration.file, "utf8"));
  }
  return db;
}

describe("Forecast migration discovery and CLI", () => {
  it("discovers current incremental files 0002..0010 in numeric order", () => {
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
    ]);
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

  it("upgrades real v1 SQL through 10 and leaves completed migrations untouched on restart", () => {
    const db = legacyDatabase(1);
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
    const before = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    runner.spawn.mockClear();
    expect(runner.run().applied).toEqual([]);
    expect(runner.files()).toEqual([]);
    expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(before);
  });

  it.each([4, 5, 6, 7, 8, 9, 10])("resumes an existing staging ledger at version %i", (version) => {
    const runner = sqliteRunner(legacyDatabase(version));
    expect(runner.run().applied).toEqual(
      currentVersions.filter((candidate) => candidate > version),
    );
  });

  it("preserves the v8 manual-review data backfill exactly once", () => {
    const db = legacyDatabase(7);
    db.exec(`INSERT INTO source_queue (source, item_id, url, title, published_at, official, status,
      first_seen_at, updated_at) VALUES ('naver-board-56', '1', 'https://example.test/1', 'test',
      '2026-09-01T00:00:00Z', 1, 'manual_review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');`);
    const runner = sqliteRunner(db);
    expect(runner.run().applied).toEqual([8, 9, 10]);
    const reviews = db.prepare("SELECT * FROM source_manual_reviews").all();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      generation: 0,
      state: "pending",
      expires_at: "2026-09-15T00:00:00.000Z",
    });
    runner.run();
    expect(db.prepare("SELECT * FROM source_manual_reviews").all()).toEqual(reviews);
  });

  it("preserves production's optional 4..6 omission and does not install Discord tables", () => {
    const db = legacyDatabase(7, true);
    const runner = sqliteRunner(db);
    expect(runner.run({ environment: "production", local: false })).toEqual({
      bootstrapped: false,
      applied: [8, 9, 10],
      versions: [1, 2, 3, 7, 8, 9, 10],
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
      expect(runner.run({ environment: "production", local: true }).applied).toEqual([8, 9, 10]);
      expect(runner.files()).toHaveLength(3);
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
    expect(runner.run().applied).toEqual([6, 7, 8, 9, 10]);
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
    expect(runner.run().applied).toEqual([7, 8, 9, 10]);
    expect(runner.files()).not.toContain("0006_discord_staging_message_identity.sql");
  });
});

describe("Forecast migration fail-closed checks", () => {
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
