import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyForecastD1Migrations } from "./apply-forecast-d1-migrations.ts";
import {
  database,
  json,
  ledgerRows,
  localStaging,
  migrations,
  currentVersions as previousVersions,
  result,
  type Spawn,
  sqliteRunner,
} from "./forecast-migration-test-fixtures.ts";
import { legacyDatabase } from "./forecast-migration-v27-fixtures.ts";

const currentVersions = [...previousVersions, 26, 27, 28, 29, 30, 31, 32, 33];

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

describe("Forecast migration fail-closed ledger checks", () => {
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
    "rejects a contiguous unknown version 30 in %s before writes",
    (environment) => {
      const spawn = vi
        .fn<Spawn>()
        .mockReturnValueOnce(result(json([{ name: "schema_migrations", type: "table" }])))
        .mockReturnValueOnce(result(json(ledgerRows([...currentVersions, 34]))));
      expect(() => applyForecastD1Migrations({ ...localStaging, environment }, { spawn })).toThrow(
        "Unknown schema_migrations version: 34",
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
    expect(() => applyForecastD1Migrations({ ...localStaging, environment }, { spawn })).toThrow(
      /Gap/,
    );
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("rejects production version 6 without its version 5 prerequisite", () => {
    const spawn = vi
      .fn<Spawn>()
      .mockReturnValueOnce(result(json([{ name: "schema_migrations", type: "table" }])))
      .mockReturnValue(result(json(ledgerRows([1, 2, 3, 6, 7]))));
    expect(() =>
      applyForecastD1Migrations({ ...localStaging, environment: "production" }, { spawn }),
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
});

describe("Forecast migration fail-closed Wrangler checks", () => {
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
});

describe("Forecast migration fail-closed post-apply checks", () => {
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
