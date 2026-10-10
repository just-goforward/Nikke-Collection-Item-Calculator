import type { SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, vi } from "vitest";
import {
  applyForecastD1Migrations,
  discoverForecastMigrations,
} from "./apply-forecast-d1-migrations.ts";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, "forecast-collector/migrations");
const migrations = discoverForecastMigrations(directory);
const currentVersions = Array.from({ length: 21 }, (_, index) => index + 1);
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
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, CURRENT_TIMESTAMP);
    CREATE TABLE collector_runs (id INTEGER PRIMARY KEY);
    INSERT INTO collector_runs VALUES (1);`);
  createLegacySourceLedger(db);
  seedLegacyAcceptedSource(db);
  for (const migration of migrations) {
    if (migration.version > version) break;
    if (production && [4, 5, 6].includes(migration.version)) continue;
    db.exec(readFileSync(migration.file, "utf8"));
  }
  return db;
}

// These core table definitions exist unchanged in original v1 (b99150b) and MAIN
// v10 (530d157a). Load the retained original snapshot, not the amended v11 schema.
function createLegacySourceLedger(db: DatabaseSync) {
  const schema = readFileSync(resolve(root, "forecast-collector/fixtures/schema-v10.sql"), "utf8");
  for (const table of [
    "source_items",
    "schedule_events",
    "forecast_candidates",
    "candidate_sources",
  ]) {
    const definition = schema.match(
      new RegExp(String.raw`CREATE TABLE IF NOT EXISTS ${table} \([\s\S]*?\r?\n\);`),
    )?.[0];
    if (!definition) throw new Error(`Original legacy table missing: ${table}`);
    db.exec(definition);
  }
}

function seedLegacyAcceptedSource(db: DatabaseSync) {
  db.prepare(`INSERT INTO source_items VALUES ('naver-board-56', '100',
    'https://game.naver.com/lounge/nikke/board/detail/100', 'Solo Raid Season 41',
    'retained excerpt; full body unavailable', '2026-09-18T08:00:36.000Z', ?, 0, 1,
    '2026-09-18T08:00:36.000Z', '2026-09-30T03:00:00.000Z')`).run("c".repeat(64));
  db.exec(`INSERT INTO schedule_events VALUES ('event-1', 'solo', 'naver-board-56', '100',
    '2026-09-24T03:00:00.000Z', '2026-09-30T19:59:00.000Z', 'confirmed', 0, NULL,
    '2026-09-30T03:00:00.000Z');`);
}

function acceptedLegacyRows(db: DatabaseSync) {
  return {
    source: db.prepare("SELECT * FROM source_items WHERE item_id='100'").get(),
    event: db.prepare("SELECT * FROM schedule_events WHERE event_id='event-1'").get(),
  };
}

function assertLegacyBaseline(db: DatabaseSync, original: ReturnType<typeof acceptedLegacyRows>) {
  expect(acceptedLegacyRows(db)).toEqual(original);
  const baseline = db
    .prepare("SELECT * FROM source_legacy_event_baselines WHERE event_id='event-1'")
    .get();
  expect(baseline?.["body_available"]).toBe(0);
  const source = JSON.parse(String(baseline?.["source_json"]));
  expect(source).toMatchObject({
    source: original.source?.["source"],
    itemId: original.source?.["item_id"],
    contentHash: original.source?.["content_hash"],
    excerpt: original.source?.["excerpt"],
    publishedAt: original.source?.["published_at"],
  });
  expect(source).not.toHaveProperty("normalizedText");
  expect(JSON.parse(String(baseline?.["event_json"]))).toMatchObject({
    startsAt: original.event?.["starts_at"],
    endsAt: original.event?.["ends_at"],
    scheduleStatus: "confirmed",
  });
  expect(db.prepare("SELECT COUNT(*) AS count FROM source_notice_revisions").get()).toEqual({
    count: 0,
  });
  return baseline;
}

export type { Spawn };
export {
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
  sqliteRunner,
};
