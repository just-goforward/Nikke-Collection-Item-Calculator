import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  acceptedLegacyRows as originalAcceptedLegacyRows,
  legacyDatabase as originalLegacyDatabase,
  root,
} from "./forecast-migration-test-fixtures.ts";

export function legacyDatabase(version: number, production = false) {
  const db = originalLegacyDatabase(version, production);
  const schema = readFileSync(resolve(root, "forecast-collector/fixtures/schema-v10.sql"), "utf8");
  const definition = schema.match(
    /CREATE TABLE IF NOT EXISTS source_watermarks \([\s\S]*?\r?\n\);/,
  )?.[0];
  if (!definition) throw new Error("Original source_watermarks definition missing");
  db.exec(definition);
  return db;
}

export function acceptedLegacyRows(db: DatabaseSync) {
  const rows = originalAcceptedLegacyRows(db);
  return { ...rows, event: { segment_json: null, ...rows.event } };
}
