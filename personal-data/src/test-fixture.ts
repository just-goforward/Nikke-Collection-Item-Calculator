/** Test-only D1 schema reset. No production entrypoint imports this module. */

import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { PersonalEnv, SqlDatabase } from "./types";

export interface FixtureEnv extends PersonalEnv {
  PERSONAL_MIGRATIONS: D1Migration[];
  PRIVACY_MIGRATIONS: D1Migration[];
  PUBLIC_MIGRATIONS: D1Migration[];
}

async function rebuild(
  db: SqlDatabase,
  tables: readonly string[],
  migrations: D1Migration[],
): Promise<void> {
  // Exact fixture tables only, children before parents. DROP does not fire row DELETE triggers.
  // Unlike reset(), this resets SQLite schema explicitly as well as persisted application rows.
  await db.batch([
    ...tables.map((table) => db.prepare(`DROP TABLE IF EXISTS "${table}"`)),
    db.prepare("DROP TABLE IF EXISTS d1_migrations"),
  ]);
  await migrateFixture(db, migrations);
}

export async function migrateFixture(db: SqlDatabase, migrations: D1Migration[]): Promise<void> {
  await applyD1Migrations(db as D1Database, migrations);
}

export async function resetFixture(env: FixtureEnv): Promise<void> {
  await rebuild(
    env.PERSONAL_DB,
    [
      "self_percentiles",
      "pending_archives",
      "stage_summaries",
      "operations",
      "workspaces",
      "sessions",
      "identities",
      "oauth_transactions",
      "deletion_jobs",
      "identity_deletion_fences",
      "blocked_identities",
      "login_rates",
      "auth_control",
      "accounts",
    ],
    env.PERSONAL_MIGRATIONS,
  );
  await rebuild(
    env.PRIVACY_CONTROL_DB,
    [
      "consent_reservations",
      "consent_operations",
      "privacy_operations",
      "tombstones",
      "consent_decisions",
    ],
    env.PRIVACY_MIGRATIONS,
  );
  await rebuild(
    env.PUBLIC_AGGREGATE_DB,
    ["current_release", "weekly_releases", "disclosure_history", "privacy_fence"],
    env.PUBLIC_MIGRATIONS,
  );
}
