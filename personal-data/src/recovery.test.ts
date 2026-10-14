import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { putConsent } from "./consent";
import { workspaceBody } from "./http";
import { reconcilePrivacyIntents, withPrivacyIntent } from "./privacy";
import { admitAccount } from "./store";
import { type FixtureEnv, resetFixture } from "./test-fixture";
import type { PersonalEnv, SqlDatabase, SqlStatement } from "./types";
import worker from "./worker";

const dbs = env as unknown as FixtureEnv;
const NOW = Date.UTC(2026, 8, 2);
const maintenance: PersonalEnv = {
  ...dbs,
  PRIVACY_RECONCILE_QUIESCENT: "true",
  PUBLICATION_ENABLED: "false",
};
const summary = {
  itemId: "one",
  stage: "R",
  lifetimeAttempts: 1,
  lifetimeIncome: 1,
  preSignupIncome: 0,
  manualEntry: false,
  verified: false,
};
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await resetFixture(dbs);
});
async function pending() {
  return dbs.PUBLIC_AGGREGATE_DB.prepare(
    "SELECT pending_intents, blocked FROM privacy_fence",
  ).first<{ pending_intents: number; blocked: number }>();
}
it("rejects unsafe or fractional item values and unsafe stage sums, accepting the exact safe ceiling", () => {
  const request = (stages: unknown[]) => ({
    opId: "save",
    baseRevision: 0,
    document: { schemaVersion: 1, items: [], lifetimeStages: stages },
    action: { kind: "save" },
  });
  for (const field of ["lifetimeIncome", "preSignupIncome", "lifetimeAttempts"]) {
    for (const value of [-1, 0.5, 1e308, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => workspaceBody(request([{ ...summary, [field]: value }]))).toThrow(
        "invalid_request",
      );
    }
  }
  const max = {
    ...summary,
    lifetimeIncome: Number.MAX_SAFE_INTEGER,
    lifetimeAttempts: Number.MAX_SAFE_INTEGER,
  };
  expect(workspaceBody(request([max])).document.lifetimeStages).toEqual([max]);
  expect(() => workspaceBody(request([max, { ...summary, itemId: "two" }]))).toThrow(
    "invalid_request",
  );
  expect(() =>
    workspaceBody(
      request([
        { ...summary, lifetimeIncome: 1e308 },
        { ...summary, itemId: "two", lifetimeIncome: 1e308 },
      ]),
    ),
  ).toThrow("invalid_request");
});
it("releases any pre-write exception, including a PRIVATE preparation outage, without changing the block", async () => {
  await expect(
    withPrivacyIntent(dbs, async () => {
      throw new Error("no_write");
    }),
  ).rejects.toThrow("no_write");
  expect((await pending())?.pending_intents).toBe(0);
  const privacy = dbs.PRIVACY_CONTROL_DB;
  const unavailable: PersonalEnv = {
    ...dbs,
    PRIVACY_CONTROL_DB: {
      prepare() {
        throw new Error("privacy_unavailable");
      },
      batch: (statements) => privacy.batch(statements),
      exec: (sql) => privacy.exec(sql),
    },
  };
  await expect(
    putConsent(
      unavailable,
      {
        userId: "absent",
        identity: { issuer: "https://accounts.google.com", sub: "absent" },
        authEpoch: 0,
        tokenHash: "hash",
        maxExpiresAt: NOW + 1000,
      },
      { opId: "consent", baseDecisionVersion: 0, participation: false },
      NOW,
    ),
  ).rejects.toThrow("privacy_unavailable");
  expect(await pending()).toEqual({ pending_intents: 0, blocked: 1 });
});
it("a PUBLIC release outage is recovered only under the explicit drained gate after all leases expire", async () => {
  const publicDb = dbs.PUBLIC_AGGREGATE_DB;
  const unavailable: PersonalEnv = {
    ...dbs,
    PUBLIC_AGGREGATE_DB: {
      prepare(sql) {
        if (sql.startsWith("DELETE FROM privacy_intents")) throw new Error("public_unavailable");
        return publicDb.prepare(sql);
      },
      batch: (statements) => publicDb.batch(statements),
      exec: (sql) => publicDb.exec(sql),
    },
  };
  await expect(withPrivacyIntent(unavailable, async () => 1)).rejects.toThrow("public_unavailable");
  expect((await pending())?.pending_intents).toBe(1);
  expect(await reconcilePrivacyIntents(dbs, NOW + 600_000)).toBe(false);
  expect(await reconcilePrivacyIntents(maintenance, NOW + 599_999)).toBe(false);
  expect(await reconcilePrivacyIntents(maintenance, NOW + 600_000)).toBe(true);
  expect(await pending()).toEqual({ pending_intents: 0, blocked: 1 });
});
it("an ambiguous PRIVATE batch failure with no resulting reservation can be reconciled after recovery", async () => {
  const privacy = dbs.PRIVACY_CONTROL_DB;
  const unavailable: PersonalEnv = {
    ...dbs,
    PRIVACY_CONTROL_DB: {
      prepare: (sql) => privacy.prepare(sql),
      batch() {
        return Promise.reject(new Error("private_batch_outage"));
      },
      exec: (sql) => privacy.exec(sql),
    },
  };
  await expect(
    putConsent(
      unavailable,
      {
        userId: "absent",
        identity: { issuer: "https://accounts.google.com", sub: "absent" },
        authEpoch: 0,
        tokenHash: "hash",
        maxExpiresAt: NOW + 1000,
      },
      { opId: "consent", baseDecisionVersion: 0, participation: false },
      NOW,
    ),
  ).rejects.toThrow("private_batch_outage");
  expect((await pending())?.pending_intents).toBe(1);
  expect(await reconcilePrivacyIntents(maintenance, NOW + 600_000)).toBe(true);
  expect(await pending()).toEqual({ pending_intents: 0, blocked: 1 });
});
it("reconciliation refuses unfinished consent/deletion/operation authority and blocks request traffic", async () => {
  await dbs.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET pending_intents = 3").run();
  await dbs.PERSONAL_DB.prepare(
    "INSERT INTO deletion_jobs (user_id, op_id, created_at, fence_generation) VALUES ('orphan', 'delete', ?, 1)",
  )
    .bind(NOW)
    .run();
  expect(await reconcilePrivacyIntents(maintenance, NOW + 600_000)).toBe(false);
  expect((await pending())?.pending_intents).toBe(3);
  expect((await worker.fetch(new Request("https://local/v1/account"), maintenance)).status).toBe(
    503,
  );
  await dbs.PERSONAL_DB.prepare("DELETE FROM deletion_jobs").run();
  await dbs.PRIVACY_CONTROL_DB.prepare(
    `INSERT INTO consent_reservations
     (user_id, op_id, request_hash, base_revision, participation, write_nonce, created_at)
     VALUES ('orphan', 'consent', 'hash', 0, 0, 'nonce', ?)`,
  )
    .bind(NOW)
    .run();
  expect(await reconcilePrivacyIntents(maintenance, NOW + 600_000)).toBe(false);
  await dbs.PRIVACY_CONTROL_DB.prepare("DELETE FROM consent_reservations").run();
  await dbs.PRIVACY_CONTROL_DB.prepare(
    "INSERT INTO privacy_operations VALUES ('op', 'orphan', 'withdrawal', 1, 'pending', ?)",
  )
    .bind(NOW)
    .run();
  expect(await reconcilePrivacyIntents(maintenance, NOW + 600_000)).toBe(false);
  await dbs.PRIVACY_CONTROL_DB.prepare("UPDATE privacy_operations SET state = 'complete'").run();
  expect(await reconcilePrivacyIntents(maintenance, NOW + 600_000)).toBe(true);
  expect(await pending()).toEqual({ pending_intents: 0, blocked: 1 });
});

it("a recovery admission after the cross-store snapshot prevents clearing orphan intents", async () => {
  await dbs.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET pending_intents = 3").run();
  const personal = dbs.PERSONAL_DB;
  const raced: PersonalEnv = {
    ...maintenance,
    PERSONAL_DB: {
      prepare(sql) {
        if (sql !== "SELECT count(*) AS n FROM deletion_jobs") return personal.prepare(sql);
        const statement = personal.prepare(sql);
        return {
          bind: (...values) => statement.bind(...values),
          run: <T>() => statement.run<T>(),
          async first<T>() {
            await withPrivacyIntent(maintenance, async () => undefined);
            return statement.first<T>();
          },
        };
      },
      batch: (statements) => personal.batch(statements),
      exec: (sql) => personal.exec(sql),
    },
  };
  expect(await reconcilePrivacyIntents(raced, NOW + 600_000)).toBe(false);
  expect(await pending()).toEqual({ pending_intents: 3, blocked: 1 });
});

/** Conservatively count each batch statement, not just one binding round-trip. */
function metered(db: SqlDatabase, add: (n: number) => void): SqlDatabase {
  const originals = new WeakMap<SqlStatement, SqlStatement>();
  const wrap = (statement: SqlStatement): SqlStatement => {
    const wrapped: SqlStatement = {
      bind: (...values) => wrap(statement.bind(...values)),
      run<T>() {
        add(1);
        return statement.run<T>();
      },
      first<T>() {
        add(1);
        return statement.first<T>();
      },
    };
    originals.set(wrapped, statement);
    return wrapped;
  };
  return {
    prepare: (sql) => wrap(db.prepare(sql)),
    batch(statements) {
      add(statements.length);
      return db.batch(statements.map((statement) => originals.get(statement) ?? statement));
    },
    exec(sql) {
      add(1);
      return db.exec(sql);
    },
  };
}
it("each cron lane stays below 40 statements, even with ready work in every lane", async () => {
  await admitAccount(
    dbs.PERSONAL_DB,
    { issuer: "https://accounts.google.com", sub: "due" },
    "due",
    Date.UTC(2024, 8, 2),
  );
  await dbs.PERSONAL_DB.prepare(
    "INSERT INTO accounts (user_id, created_at, last_active_at, blocked) VALUES ('deleting', ?, ?, 1)",
  )
    .bind(NOW, NOW)
    .run();
  await dbs.PERSONAL_DB.prepare(
    "INSERT INTO deletion_jobs (user_id, op_id, created_at, fence_generation, fence_ready) VALUES ('deleting', 'delete', ?, 0, 0)",
  )
    .bind(NOW)
    .run();
  await admitAccount(
    dbs.PERSONAL_DB,
    { issuer: "https://accounts.google.com", sub: "consent" },
    "consent",
    NOW,
  );
  await dbs.PRIVACY_CONTROL_DB.prepare(
    `INSERT INTO consent_reservations
     (user_id, op_id, request_hash, base_revision, participation, write_nonce, created_at)
     VALUES ('consent', 'consent', 'hash', 0, 0, 'nonce', ?)`,
  )
    .bind(NOW)
    .run();
  for (const cron of ["0-59/10 * * * *", "1-59/10 * * * *", "2-59/10 * * * *", "3-59/10 * * * *"]) {
    let count = 0;
    const add = (n: number) => {
      count += n;
    };
    const measured: PersonalEnv = {
      ...dbs,
      PUBLICATION_ENABLED: "true",
      PERSONAL_DB: metered(dbs.PERSONAL_DB, add),
      PRIVACY_CONTROL_DB: metered(dbs.PRIVACY_CONTROL_DB, add),
      PUBLIC_AGGREGATE_DB: metered(dbs.PUBLIC_AGGREGATE_DB, add),
    };
    await worker.scheduled({ scheduledTime: NOW, cron }, measured);
    expect(count).toBeLessThan(40);
    expect(count).toBeGreaterThan(3);
  }
});
