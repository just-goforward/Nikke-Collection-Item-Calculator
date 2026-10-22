import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import {
  applyForecastD1Migrations,
  parseMigrationArguments,
} from "./apply-forecast-d1-migrations.ts";
import { fixtureDirectory, migrations, sqliteRunner } from "./forecast-migration-test-fixtures.ts";
import { legacyDatabase } from "./forecast-migration-v27-fixtures.ts";

it.each(["staging", "production"] as const)(
  "refuses pending v2 migrations in %s before any Wrangler call",
  (environment) => {
    const runner = sqliteRunner(legacyDatabase(26, environment === "production"));
    expect(() =>
      applyForecastD1Migrations(parseMigrationArguments([`--env=${environment}`, "--remote"]), {
        spawn: runner.spawn,
      }),
    ).toThrow("Forecast v2 migrations require --allow-forecast-v2: 30, 31, 32, 33, 34.");
    expect(runner.spawn).not.toHaveBeenCalled();
  },
);

it("applies v2 with explicit CLI authorization", () => {
  const db = legacyDatabase(29);
  const runner = sqliteRunner(db);
  expect(
    applyForecastD1Migrations(
      parseMigrationArguments(["--env=staging", "--local", "--allow-forecast-v2"]),
      { spawn: runner.spawn, log: () => {} },
    ).applied,
  ).toEqual([30, 31, 32, 33, 34]);
});

it("keeps a migration inventory through v29 usable without the flag", () => {
  const root = fixtureDirectory([]);
  const directory = join(root, "forecast-collector", "migrations");
  mkdirSync(directory, { recursive: true });
  for (const migration of migrations.filter((entry) => entry.version <= 29)) {
    writeFileSync(join(directory, basename(migration.file)), readFileSync(migration.file));
  }
  const runner = sqliteRunner(legacyDatabase(26));
  expect(
    applyForecastD1Migrations(parseMigrationArguments(["--env=staging", "--local"]), {
      root,
      spawn: runner.spawn,
      log: () => {},
    }).applied,
  ).toEqual([27, 28, 29]);
});
