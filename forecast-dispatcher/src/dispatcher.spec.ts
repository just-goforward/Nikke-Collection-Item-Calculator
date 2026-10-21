import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  migratePublicationDb,
  seedCandidate,
  TEST_NOW,
} from "../../shared/forecast-publication/test-fixtures.ts";
import { runDispatcher } from "./dispatcher.ts";
import { localDatabase } from "./test-database.ts";
import type { DispatcherEnv } from "./types.ts";

/**
 * Runs in the Node/SQLite lane. This scenario drives 26 full dispatcher passes and
 * each D1 round trip costs ~4 ms inside workerd regardless of the query, so the same
 * coverage needs ~2 s there and overruns the per-test budget under suite load. Local
 * SQLite removes that per-statement transport cost; every assertion below is the
 * same as in the workerd lane's equivalent test.
 */
const originalNow = Date.now;

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  const db = localDatabase(sqlite);
  await migratePublicationDb(db, async (_db, migrations) => {
    for (const migration of migrations) sqlite.exec(migration.queries.join("\n"));
    sqlite.exec("CREATE TABLE IF NOT EXISTS __test_sql_migrations(name TEXT)");
  });
  const env: DispatcherEnv = {
    FORECAST_DB: db,
    ENVIRONMENT: "staging",
    DEPLOY_SHA: "dispatcher-node-spec",
    DISPATCH_ENABLED: "true",
    PUBLICATION_MODE: "enabled",
    DISCORD_BOT_TOKEN: "local-test-token",
    DISCORD_APPROVAL_CHANNEL_ID: "123456789012345678",
    DISCORD_ALERT_CHANNEL_ID: "123456789012345678",
    DISCORD_CHANNEL_ID: "123456789012345678",
    DISCORD_ACTIVITY_CHANNEL_ID: "123456789012345678",
    DISCORD_FALLBACK_CHANNEL_ID: "123456789012345678",
    FORECAST_V2_NOTIFICATIONS_ENABLED: "false",
    USAGE_GUARD_DB: db,
  };
  return { sqlite, db, env };
}

afterEach(() => {
  Date.now = originalNow;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("admits an older valid candidate past newer legacy/invalid candidates and caps failed retries", async () => {
  const { sqlite, db, env } = await fixture();
  try {
    Date.now = () => TEST_NOW;
    const outbound = vi.fn(async (input: RequestInfo | URL) => {
      assert.match(String(input), /^https:\/\/discord\.com\/api\/v10\//);
      return Response.json({ id: "123456789012345678" });
    });
    vi.stubGlobal("fetch", outbound);
    // The oldest candidate is valid and v3; the five newer ones are legacy (rules
    // version) or structurally invalid, so each is rejected once and retried.
    const valid = await seedCandidate(db);
    await db
      .prepare("UPDATE forecast_candidates SET created_at=? WHERE candidate_id=?")
      .bind(new Date(TEST_NOW - 1).toISOString(), valid.candidate.candidateId)
      .run();
    for (let revision = 2; revision <= 6; revision += 1) {
      const { candidate } = await seedCandidate(db, revision);
      await db
        .prepare("UPDATE forecast_candidates SET payload_json=?,created_at=? WHERE candidate_id=?")
        .bind(
          JSON.stringify(
            revision % 2 === 0
              ? { ...candidate, payloadVersion: 3, rulesVersion: "schedule-kit-v2" }
              : { certifiedSnapshot: candidate.certifiedSnapshot },
          ),
          new Date(TEST_NOW + revision).toISOString(),
          candidate.candidateId,
        )
        .run();
    }
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let run = 0; run < 5; run += 1) await runDispatcher(env);
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM forecast_runtime_reviews WHERE action='approve'")
        .first(),
    ).toEqual({ n: 0 });
    expect(
      (
        await db
          .prepare(
            "SELECT state,attempts,next_attempt_at,error_code FROM forecast_runtime_admissions",
          )
          .all()
      ).results,
    ).toEqual(
      Array.from({ length: 5 }, () => ({
        state: "pending",
        attempts: 1,
        next_attempt_at: TEST_NOW + 5 * 60_000,
        error_code: expect.stringMatching(/^publication_/),
      })),
    );
    // Even when the failures are due again, an untried candidate gets priority.
    Date.now = () => TEST_NOW + 5 * 60_000;
    await runDispatcher(env);
    expect(
      await db
        .prepare(`SELECT r.candidate_id,o.state FROM forecast_runtime_reviews r
        JOIN forecast_runtime_outbox o ON o.review_id=r.review_id WHERE r.action='approve'`)
        .first(),
    ).toEqual({ candidate_id: valid.candidate.candidateId, state: "sent" });
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      Date.now = () => TEST_NOW + attempt * 5 * 60_000;
      for (let run = 0; run < 5; run += 1) await runDispatcher(env);
    }
    const terminal = await db
      .prepare(
        "SELECT state,attempts,error_code FROM forecast_runtime_admissions WHERE candidate_id!=?",
      )
      .bind(valid.candidate.candidateId)
      .all();
    expect(terminal.results).toEqual(
      Array.from({ length: 5 }, () => ({
        state: "dead",
        attempts: 5,
        error_code: expect.stringMatching(/^publication_/),
      })),
    );
    expect(warnings).toHaveBeenCalledTimes(25);
    Date.now = () => TEST_NOW + 60 * 60_000;
    await runDispatcher(env);
    expect(warnings).toHaveBeenCalledTimes(25);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    sqlite.close();
  }
});
