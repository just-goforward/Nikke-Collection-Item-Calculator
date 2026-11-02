import { beforeEach, expect, it, vi } from "vitest";
import { resumeDeletion, runPrivacyMaintenance } from "./consent";
import { runInactivityDeletion } from "./inactivity";
import { applyPrivacyChange, reapplyTombstones } from "./privacy";
import { publishWeekly } from "./publication";
import { fixtureEnv, resetFixture } from "./test-fixture";
import type { PersonalEnv, SqlDatabase, SqlStatement } from "./types";
import worker from "./worker";

/**
 * Sentinel tests: every reported failure must be a fixed event/code pair. A secret, an
 * account identifier, or a record value placed in the failure and in the stored data must
 * never appear in the emitted record.
 */
const dbs = fixtureEnv();
const NOW = Date.UTC(2026, 8, 2);
const SECRET = "SENTINEL_ERROR_TEXT_9f3a";
const OWNER = "SENTINEL_USER_42";
const RECORD = "SENTINEL_RECORD_CONTENT_77";

function capture() {
  const records: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    records.push(args.map((value) => String(value)).join(" "));
  });
  return records;
}

/** Every record is exactly one fixed JSON object; nothing free-form can reach it. */
function expectOnlyFixedRecords(records: string[]) {
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(record).toMatch(
      /^\{"event":"personal_data_[a-z_]+","code":"[a-z_]+"(?:,"lane":[0-5])?\}$/,
    );
    expect(record).not.toContain(SECRET);
    expect(record).not.toContain(OWNER);
    expect(record).not.toContain(RECORD);
  }
}

function failing(db: SqlDatabase, failure: unknown, prefix?: string): SqlDatabase {
  return {
    prepare(sql) {
      if (prefix === undefined || sql.startsWith(prefix)) throw failure;
      return db.prepare(sql);
    },
    batch: (statements) => db.batch(statements),
    exec: (sql) => db.exec(sql),
  };
}

const unchanged = { results: [], meta: { changes: 0 }, success: true };

/** Executes the real statement but reports zero changes, modelling an unapplied write. */
function unapplied(db: SqlDatabase, prefix: string): SqlDatabase {
  const originals = new WeakMap<SqlStatement, SqlStatement>();
  const queries = new WeakMap<SqlStatement, string>();
  const wrap = (statement: SqlStatement, sql: string): SqlStatement => {
    const wrapped: SqlStatement = {
      bind: (...values) => wrap(statement.bind(...values), sql),
      run: <T>() =>
        sql.startsWith(prefix) ? Promise.resolve(unchanged as never) : statement.run<T>(),
      first: <T>() => statement.first<T>(),
    };
    originals.set(wrapped, statement);
    queries.set(wrapped, sql);
    return wrapped;
  };
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    async batch<T = Record<string, unknown>>(statements: SqlStatement[]) {
      const results = await db.batch<T>(
        statements.map((statement) => originals.get(statement) ?? statement),
      );
      return statements.map((statement, index) =>
        (queries.get(statement) ?? "").startsWith(prefix) ? (unchanged as never) : results[index]!,
      );
    },
    exec: (sql) => db.exec(sql),
  };
}

/** A guarded admission that matched no row, as when the fence is already claimed. */
function noRows(db: SqlDatabase, prefix: string): SqlDatabase {
  const empty: SqlStatement = {
    bind: () => empty,
    run: () => Promise.resolve(unchanged as never),
    first: () => Promise.resolve(null),
  };
  return {
    prepare: (sql) => (sql.startsWith(prefix) ? empty : db.prepare(sql)),
    batch: <T = Record<string, unknown>>(statements: SqlStatement[]) => db.batch<T>(statements),
    exec: (sql) => db.exec(sql),
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetFixture(dbs);
});

it("reports each scheduled lane failure with its lane and never the failure text", async () => {
  const records = capture();
  const unavailable: PersonalEnv = {
    ...dbs,
    PERSONAL_DB: failing(dbs.PERSONAL_DB, new Error(SECRET)),
  };
  await expect(worker.scheduled({ scheduledTime: NOW }, unavailable)).rejects.toThrow(
    "maintenance_failed",
  );
  expect(records).toEqual([
    JSON.stringify({ event: "personal_data_expiry_cleanup_failed", code: "unexpected", lane: 0 }),
  ]);
  expectOnlyFixedRecords(records);
});

it("reports an unapplied deletion as a failure, with no account identifier and no success", async () => {
  await dbs.PERSONAL_DB.batch([
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO accounts (user_id, created_at, last_active_at, blocked) VALUES (?, ?, ?, 1)",
    ).bind(OWNER, NOW, NOW),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO deletion_jobs (user_id, op_id, created_at, fence_generation) VALUES (?, 'op', ?, 1)",
    ).bind(OWNER, NOW),
  ]);
  const records = capture();
  const unavailable: PersonalEnv = {
    ...dbs,
    PRIVACY_CONTROL_DB: failing(
      dbs.PRIVACY_CONTROL_DB,
      new Error(`${SECRET} ${OWNER}`),
      "INSERT INTO privacy_operations",
    ),
    PRIVACY_RECONCILE_QUIESCENT: "true",
  };
  await runPrivacyMaintenance(unavailable, NOW, "deletion");
  expect(records).toEqual([
    JSON.stringify({ event: "personal_data_deletion_resume_failed", code: "unexpected" }),
  ]);
  expectOnlyFixedRecords(records);
  // The job survives with a durable backoff, so the failure is never reported as completed.
  expect(
    await dbs.PERSONAL_DB.prepare("SELECT retry_after FROM deletion_jobs WHERE user_id = ?")
      .bind(OWNER)
      .first(),
  ).toEqual({ retry_after: NOW + 60_000 });
});

it("reports a typed rejection by its closed reason code instead of any message", async () => {
  await dbs.PERSONAL_DB.batch([
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO accounts (user_id, created_at, last_active_at, blocked) VALUES (?, ?, ?, 1)",
    ).bind(OWNER, NOW, NOW),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO deletion_jobs (user_id, op_id, created_at, fence_generation) VALUES (?, 'op', ?, 1)",
    ).bind(OWNER, NOW),
  ]);
  const records = capture();
  await runPrivacyMaintenance(
    {
      ...dbs,
      PUBLIC_AGGREGATE_DB: noRows(dbs.PUBLIC_AGGREGATE_DB, "INSERT INTO privacy_intents"),
      PRIVACY_RECONCILE_QUIESCENT: "true",
    },
    NOW,
    "deletion",
  );
  expect(records).toEqual([
    JSON.stringify({ event: "personal_data_deletion_resume_failed", code: "service_unavailable" }),
  ]);
  expectOnlyFixedRecords(records);
});

it("reports a stuck consent retry without the reservation's user id", async () => {
  await dbs.PRIVACY_CONTROL_DB.prepare(
    `INSERT INTO consent_reservations
     (user_id, op_id, request_hash, base_revision, participation, write_nonce, created_at, busy_until)
     VALUES (?, 'op', 'hash', 0, 1, 'nonce', ?, 0)`,
  )
    .bind(OWNER, NOW)
    .run();
  const records = capture();
  await runPrivacyMaintenance(
    {
      ...dbs,
      PRIVACY_CONTROL_DB: failing(
        dbs.PRIVACY_CONTROL_DB,
        new Error(SECRET),
        "INSERT INTO consent_decisions",
      ),
      PRIVACY_RECONCILE_QUIESCENT: "true",
    },
    NOW,
    "consent",
  );
  expectOnlyFixedRecords(records);
  expect(records).toEqual([
    JSON.stringify({ event: "personal_data_consent_maintenance_failed", code: "unexpected" }),
  ]);
  expect(
    await dbs.PRIVACY_CONTROL_DB.prepare(
      "SELECT maintenance_after FROM consent_reservations WHERE user_id = ?",
    )
      .bind(OWNER)
      .first(),
  ).toEqual({ maintenance_after: NOW + 60_000 });
});

it("reports an inactivity deletion failure without the due account's identity", async () => {
  await dbs.PERSONAL_DB.batch([
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO accounts (user_id, created_at, last_active_at) VALUES (?, ?, ?)",
    ).bind(OWNER, Date.UTC(2024, 2, 1, 12), Date.UTC(2024, 2, 1, 12)),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO identities (issuer, subject, user_id) VALUES ('https://accounts.google.com', ?, ?)",
    ).bind(OWNER, OWNER),
  ]);
  const records = capture();
  await runInactivityDeletion(
    { ...dbs, PUBLIC_AGGREGATE_DB: failing(dbs.PUBLIC_AGGREGATE_DB, new Error(SECRET)) },
    NOW,
  );
  expectOnlyFixedRecords(records);
  expect(records).toEqual([
    JSON.stringify({ event: "personal_data_inactivity_failed", code: "unexpected" }),
  ]);
});

it("reports an unreadable publication summary without its stored contents", async () => {
  await dbs.PERSONAL_DB.batch([
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO accounts (user_id, created_at, last_active_at) VALUES (?, ?, ?)",
    ).bind(OWNER, NOW, NOW),
    dbs.PERSONAL_DB.prepare("INSERT INTO stage_summaries VALUES (?, 'item', 'R', ?)").bind(
      OWNER,
      JSON.stringify({ itemId: "item", stage: "R", note: RECORD }),
    ),
  ]);
  const records = capture();
  expect(await publishWeekly({ ...dbs, PUBLICATION_ENABLED: "true" }, NOW)).toBe("published");
  expectOnlyFixedRecords(records);
  expect(records).toEqual([
    JSON.stringify({ event: "personal_data_publication_summary_invalid", code: "invalid_summary" }),
  ]);
});

it("reports an unexpected request exception as a fixed code with the unchanged 503 contract", async () => {
  const records = capture();
  const response = await worker.fetch(new Request("https://local/v1/statistics"), {
    ...dbs,
    PUBLICATION_ENABLED: "true",
    PUBLIC_AGGREGATE_DB: failing(dbs.PUBLIC_AGGREGATE_DB, new Error(SECRET)),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "service_unavailable" });
  expectOnlyFixedRecords(records);
  expect(records).toEqual([
    JSON.stringify({ event: "personal_data_request_failed", code: "unexpected" }),
  ]);
});

it("reports an unapplied completion marker as pending, not as a completed change", async () => {
  await dbs.PERSONAL_DB.prepare(
    "INSERT INTO accounts (user_id, created_at, last_active_at) VALUES (?, ?, ?)",
  )
    .bind(OWNER, NOW, NOW)
    .run();
  const records = capture();
  const stuck = unapplied(
    dbs.PRIVACY_CONTROL_DB,
    "UPDATE privacy_operations SET state = 'complete'",
  );
  const result = await applyPrivacyChange(
    { ...dbs, PRIVACY_CONTROL_DB: stuck },
    { userId: OWNER, opId: "op", kind: "withdrawal" },
    NOW,
  );
  expect(result).toEqual({ fenceGeneration: 1, status: "pending" });
  expectOnlyFixedRecords(records);
  expect(records).toEqual([
    JSON.stringify({ event: "personal_data_privacy_completion_failed", code: "incomplete_write" }),
  ]);
  // The operation stays pending, which is exactly what keeps the public fence closed.
  expect(
    await dbs.PRIVACY_CONTROL_DB.prepare(
      "SELECT state FROM privacy_operations WHERE op_id = 'op' AND user_id = ?",
    )
      .bind(OWNER)
      .first(),
  ).toEqual({ state: "pending" });
  // A later attempt with working storage records the completion durably.
  expect(
    await applyPrivacyChange(dbs, { userId: OWNER, opId: "op", kind: "withdrawal" }, NOW + 1),
  ).toEqual({ fenceGeneration: 2, status: "complete" });
  expect(
    await dbs.PRIVACY_CONTROL_DB.prepare(
      "SELECT state FROM privacy_operations WHERE op_id = 'op' AND user_id = ?",
    )
      .bind(OWNER)
      .first(),
  ).toEqual({ state: "complete" });
});

it("an unapplied deletion completion keeps the job and does not report the deletion as done", async () => {
  await dbs.PERSONAL_DB.batch([
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO accounts (user_id, created_at, last_active_at, blocked) VALUES (?, ?, ?, 1)",
    ).bind(OWNER, NOW, NOW),
    // Unready like a fresh claim: this attempt raises the fence and claims the job itself.
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO deletion_jobs (user_id, op_id, created_at, fence_generation, fence_ready) VALUES (?, 'op', ?, 0, 0)",
    ).bind(OWNER, NOW),
  ]);
  const records = capture();
  const stuck = unapplied(
    dbs.PRIVACY_CONTROL_DB,
    "UPDATE privacy_operations SET state = 'complete'",
  );
  expect(await resumeDeletion({ ...dbs, PRIVACY_CONTROL_DB: stuck }, OWNER)).toBe(false);
  expectOnlyFixedRecords(records);
  expect(records).toEqual([
    JSON.stringify({ event: "personal_data_deletion_completion_failed", code: "incomplete_write" }),
  ]);
  // The durable job survives with its retry state, so automatic recovery is not lost.
  expect(
    await dbs.PERSONAL_DB.prepare("SELECT retry_after FROM deletion_jobs WHERE user_id = ?")
      .bind(OWNER)
      .first(),
  ).toEqual({ retry_after: 0 });
  expect(
    await dbs.PRIVACY_CONTROL_DB.prepare(
      "SELECT state FROM privacy_operations WHERE user_id = ? AND kind = 'deletion'",
    )
      .bind(OWNER)
      .first(),
  ).toEqual({ state: "pending" });
  // Publication stays blocked while the operation is pending; a working retry then completes.
  expect(
    await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT blocked FROM privacy_fence").first(),
  ).toEqual({ blocked: 1 });
  expect(await resumeDeletion(dbs, OWNER)).toBe(true);
  expect(
    await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM deletion_jobs WHERE user_id = ?")
      .bind(OWNER)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await dbs.PRIVACY_CONTROL_DB.prepare(
      "SELECT state FROM privacy_operations WHERE user_id = ? AND kind = 'deletion'",
    )
      .bind(OWNER)
      .first(),
  ).toEqual({ state: "complete" });
});

it("reports a staged release whose publisher token could not be released", async () => {
  // A pending privacy operation takes the abort path, which must release the publisher token.
  await dbs.PRIVACY_CONTROL_DB.prepare(
    "INSERT INTO privacy_operations VALUES ('op', 'someone', 'withdrawal', 1, 'pending', ?)",
  )
    .bind(NOW)
    .run();
  const records = capture();
  const publicDb = dbs.PUBLIC_AGGREGATE_DB;
  const stuck: PersonalEnv = {
    ...dbs,
    PUBLICATION_ENABLED: "true",
    PUBLIC_AGGREGATE_DB: unapplied(publicDb, "UPDATE privacy_fence SET publisher_token = NULL"),
  };
  expect(await publishWeekly(stuck, NOW)).toBe("blocked");
  expectOnlyFixedRecords(records);
  expect(records).toEqual([
    JSON.stringify({
      event: "personal_data_publication_token_release_failed",
      code: "incomplete_write",
    }),
  ]);
  // Publication stays blocked rather than being reported as published.
  expect(await publicDb.prepare("SELECT blocked FROM privacy_fence").first()).toEqual({
    blocked: 1,
  });
});

it("reports a restore page that could not advance its durable checkpoint", async () => {
  const records = capture();
  const checkpoint = {
    intent_version: 3,
    cursor: "cursor",
    page: JSON.stringify([{ user_id: OWNER, deletion: 1, withdrawal: 0 }]),
    complete: 0,
    jobs: 0,
  };
  await reapplyTombstones(
    {
      ...dbs,
      PERSONAL_DB: unapplied(dbs.PERSONAL_DB, "UPDATE restore_replay SET cursor = ?"),
    },
    { intentVersion: 3, checkpoint },
  );
  expectOnlyFixedRecords(records);
  expect(records).toEqual([
    JSON.stringify({ event: "personal_data_restore_checkpoint_failed", code: "incomplete_write" }),
  ]);
});
