import type { DatabaseSync } from "node:sqlite";
import {
  acceptedLegacyRows as originalAcceptedLegacyRows,
  legacyDatabase as originalLegacyDatabase,
} from "./forecast-migration-test-fixtures.ts";

export function legacyDatabase(version: number, production = false) {
  return originalLegacyDatabase(version, production);
}

export function acceptedLegacyRows(db: DatabaseSync) {
  const rows = originalAcceptedLegacyRows(db);
  return { ...rows, event: { segment_json: null, ...rows.event } };
}
