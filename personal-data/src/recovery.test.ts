import { beforeEach, expect, it, vi } from "vitest";
import { createSession } from "./auth";
import { putConsent } from "./consent";
import { workspaceBody } from "./http";
import { applyPrivacyChange, reconcilePrivacyIntents, withPrivacyIntent } from "./privacy";
import { admitAccount, EMPTY_DOCUMENT, putWorkspace } from "./store";
import { fixtureEnv, resetFixture } from "./test-fixture";
import type { PersonalEnv, SqlDatabase, SqlStatement } from "./types";
import worker, { scheduledLane } from "./worker";

const dbs = fixtureEnv();
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
function metered(
  db: SqlDatabase,
  add: (n: number) => void,
  before: (sql: string) => void = () => undefined,
): SqlDatabase {
  const originals = new WeakMap<SqlStatement, SqlStatement>();
  const queries = new WeakMap<SqlStatement, string>();
  const wrap = (statement: SqlStatement, sql: string): SqlStatement => {
    const wrapped: SqlStatement = {
      bind: (...values) => wrap(statement.bind(...values), sql),
      run<T>() {
        add(1);
        before(sql);
        return statement.run<T>();
      },
      first<T>() {
        add(1);
        before(sql);
        return statement.first<T>();
      },
    };
    originals.set(wrapped, statement);
    queries.set(wrapped, sql);
    return wrapped;
  };
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch(statements) {
      add(statements.length);
      for (const statement of statements) before(queries.get(statement) ?? "");
      return db.batch(statements.map((statement) => originals.get(statement) ?? statement));
    },
    exec(sql) {
      add(1);
      return db.exec(sql);
    },
  };
}
async function readyWork() {
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
}

const ceilings = [3, 24, 27, 27, 19, 8] as const;
function laneTime(lane: number) {
  return NOW + lane * 10 * 60_000;
}
function measure(flags: Partial<PersonalEnv> = {}, failure = "") {
  let count = 0;
  let failed = false;
  const add = (n: number) => {
    count += n;
  };
  const before = (sql: string) => {
    if (!failed && failure && sql.startsWith(failure)) {
      failed = true;
      throw new Error("injected_statement_outage");
    }
  };
  return {
    count: () => count,
    failed: () => failed,
    env: {
      ...dbs,
      PUBLICATION_ENABLED: "true",
      ...flags,
      PERSONAL_DB: metered(dbs.PERSONAL_DB, add, before),
      PRIVACY_CONTROL_DB: metered(dbs.PRIVACY_CONTROL_DB, add, before),
      PUBLIC_AGGREGATE_DB: metered(dbs.PUBLIC_AGGREGATE_DB, add, before),
    } satisfies PersonalEnv,
  };
}

it("selects all six UTC lanes from scheduledTime across hour/day boundaries, not delivery time", () => {
  for (const hour of [NOW, NOW + 23 * 3_600_000, NOW + 24 * 3_600_000]) {
    for (let lane = 0; lane < 6; lane++) {
      expect(scheduledLane(hour + lane * 600_000)).toBe(lane);
      expect(scheduledLane(hour + (lane + 1) * 600_000 - 1)).toBe(lane);
    }
  }
});

it.each([0, 1, 2, 3, 4, 5])(
  "lane %i respects its documented ceiling and isolates other ready queues",
  async (lane) => {
    await readyWork();
    const measured = measure();
    await worker.scheduled({ scheduledTime: laneTime(lane), cron: "*/10 * * * *" }, measured.env);
    expect(measured.count()).toBeLessThanOrEqual(ceilings[lane]!);
    expect(measured.count()).toBeGreaterThanOrEqual(3);
    expect(
      await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM deletion_jobs").first(),
    ).toEqual({ n: lane === 1 ? 0 : 1 });
    expect(
      await dbs.PRIVACY_CONTROL_DB.prepare(
        "SELECT count(*) AS n FROM consent_reservations",
      ).first(),
    ).toEqual({ n: lane === 2 ? 0 : 1 });
    expect(
      await dbs.PERSONAL_DB.prepare(
        "SELECT count(*) AS n FROM accounts WHERE user_id = 'due'",
      ).first(),
    ).toEqual({ n: lane === 3 ? 0 : 1 });
  },
);

it("full publication and gated reconciliation obey their own ceilings", async () => {
  const publication = measure();
  await worker.scheduled({ scheduledTime: laneTime(4) }, publication.env);
  expect(publication.count()).toBeLessThanOrEqual(ceilings[4]);
  expect(
    await dbs.PUBLIC_AGGREGATE_DB.prepare(
      "SELECT count(*) AS n FROM weekly_releases WHERE state = 'published'",
    ).first(),
  ).toEqual({ n: 1 });
  // Empty replay still initializes/purges, scans, then reconciles in separate slots.
  for (let slot = 0; slot < 3; slot++) {
    const recovery = measure(maintenance);
    await worker.scheduled({ scheduledTime: laneTime(5) + slot * 3_600_000 }, recovery.env);
    expect(recovery.count()).toBeLessThanOrEqual(ceilings[5]);
    expect(
      await dbs.PUBLIC_AGGREGATE_DB.prepare(
        "SELECT reconciliation_gate FROM privacy_fence",
      ).first(),
    ).toEqual({ reconciliation_gate: Number(slot < 2) });
  }
  expect(
    await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT reconciliation_gate FROM privacy_fence").first(),
  ).toEqual({ reconciliation_gate: 0 });
});

it.each([
  { lane: 1, failure: "INSERT INTO privacy_operations", backoff: "deletion" },
  { lane: 1, failure: "DELETE FROM privacy_intents", backoff: "deletion" },
  { lane: 2, failure: "INSERT INTO consent_decisions", backoff: "consent" },
  { lane: 2, failure: "SELECT participation", backoff: "consent" },
  { lane: 3, failure: "INSERT INTO privacy_intents", backoff: "inactivity" },
  { lane: 3, failure: "INSERT INTO privacy_operations", backoff: "" },
])(
  "lane $lane stays within its ceiling on $failure and isolates failure/backoff",
  async ({ lane, failure, backoff }) => {
    await readyWork();
    const measured = measure({}, failure);
    await worker.scheduled({ scheduledTime: laneTime(lane) }, measured.env);
    expect(measured.failed()).toBe(true);
    expect(measured.count()).toBeLessThanOrEqual(ceilings[lane]!);
    const time = laneTime(lane) + 60_000;
    if (backoff === "deletion") {
      // A failed release after completed deletion has no surviving job to back off.
      const row = await dbs.PERSONAL_DB.prepare(
        "SELECT retry_after FROM deletion_jobs WHERE user_id = 'deleting'",
      ).first();
      expect(row).toEqual(failure === "DELETE FROM privacy_intents" ? null : { retry_after: time });
    } else if (backoff === "consent") {
      const row = await dbs.PRIVACY_CONTROL_DB.prepare(
        "SELECT maintenance_after FROM consent_reservations WHERE user_id = 'consent'",
      ).first();
      expect(row).toEqual(failure === "SELECT participation" ? null : { maintenance_after: time });
    } else if (backoff === "inactivity") {
      expect(
        await dbs.PERSONAL_DB.prepare(
          "SELECT inactivity_retry_after, blocked FROM accounts WHERE user_id = 'due'",
        ).first(),
      ).toEqual({ inactivity_retry_after: time, blocked: 0 });
    }
  },
);

it.each([
  { lane: 1, failure: "DELETE FROM identity_deletion_fences" },
  { lane: 4, failure: "INSERT INTO weekly_releases" },
  { lane: 5, failure: "DELETE FROM privacy_intents" },
])("lane $lane reports $failure without exceeding its ceiling", async ({ lane, failure }) => {
  if (lane === 1) await readyWork();
  if (lane === 5) {
    await worker.scheduled({ scheduledTime: laneTime(5) }, maintenance);
    await worker.scheduled({ scheduledTime: laneTime(5) + 3_600_000 }, maintenance);
  }
  const measured = measure(lane === 5 ? maintenance : {}, failure);
  await expect(worker.scheduled({ scheduledTime: laneTime(lane) }, measured.env)).rejects.toThrow(
    "maintenance_failed",
  );
  expect(measured.failed()).toBe(true);
  expect(measured.count()).toBeLessThanOrEqual(ceilings[lane]!);
  if (lane === 1) {
    expect(
      await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM deletion_jobs").first(),
    ).toEqual({ n: 0 });
  }
});

async function restoreStep(slot: number, failure = "") {
  const measured = measure(maintenance, failure);
  const result = worker.scheduled({ scheduledTime: laneTime(5) + slot * 3_600_000 }, measured.env);
  if (failure) await expect(result).rejects.toThrow("maintenance_failed");
  else await result;
  expect(measured.count()).toBeLessThanOrEqual(ceilings[5]);
  expect(measured.failed()).toBe(Boolean(failure));
  return measured.count();
}

async function restoreGate() {
  return dbs.PUBLIC_AGGREGATE_DB.prepare(
    "SELECT reconciliation_gate, pending_intents, blocked FROM privacy_fence",
  ).first();
}

async function deletedSnapshot() {
  await applyPrivacyChange(
    dbs,
    { userId: "restored", opId: "delete-restored", kind: "deletion" },
    NOW,
  );
  await admitAccount(
    dbs.PERSONAL_DB,
    { issuer: "https://accounts.google.com", sub: "restored" },
    "restored",
    NOW,
  );
  await createSession(dbs.PERSONAL_DB, "restored", NOW);
  await putWorkspace(
    dbs.PERSONAL_DB,
    "restored",
    {
      opId: "restored-save",
      baseRevision: 0,
      document: { ...EMPTY_DOCUMENT, lifetimeStages: [summary] },
      action: {
        kind: "archive",
        archive: {
          archiveId: "restored-archive",
          summary,
          startedAt: NOW - 1000,
          completedAt: NOW,
        },
      },
    },
    NOW,
  );
  await dbs.PERSONAL_DB.prepare(
    "INSERT INTO self_percentiles VALUES ('restored', 'restored-release', 'R', '{}')",
  ).run();
}

it("maintenance :50 replays a restored deletion and purges ranks before reopening reconciliation", async () => {
  await deletedSnapshot();
  const tables = [
    "accounts",
    "identities",
    "sessions",
    "workspaces",
    "operations",
    "stage_summaries",
    "pending_archives",
    "self_percentiles",
  ];
  for (const table of tables) {
    expect(await dbs.PERSONAL_DB.prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({
      n: 1,
    });
  }
  for (let slot = 0; slot < 4; slot++) {
    expect(await restoreStep(slot)).toBe([8, 7, 8, 8][slot]);
    expect(await restoreGate()).toEqual({
      reconciliation_gate: Number(slot < 3),
      pending_intents: 0,
      blocked: 1,
    });
    if (slot === 0) {
      expect(
        await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM self_percentiles").first(),
      ).toEqual({ n: 0 });
    }
  }
  for (const table of tables) {
    expect(await dbs.PERSONAL_DB.prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({
      n: 0,
    });
  }
  expect(
    await dbs.PRIVACY_CONTROL_DB.prepare(
      "SELECT kind FROM tombstones WHERE user_id = 'restored'",
    ).first(),
  ).toEqual({ kind: "deletion" });
});

it("repeated maintenance :50 runs preserve the reconciled open gate and current version", async () => {
  await deletedSnapshot();
  for (let slot = 0; slot < 4; slot++) await restoreStep(slot);
  const before = await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT * FROM privacy_fence").first();
  const checkpoint = await dbs.PERSONAL_DB.prepare("SELECT * FROM restore_replay").first();
  for (let slot = 4; slot < 7; slot++) {
    expect(await restoreStep(slot)).toBe(5);
    expect(await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT * FROM privacy_fence").first()).toEqual(
      before,
    );
    expect(await dbs.PERSONAL_DB.prepare("SELECT * FROM restore_replay").first()).toEqual(
      checkpoint,
    );
    expect(await restoreGate()).toEqual({ reconciliation_gate: 0, pending_intents: 0, blocked: 1 });
  }
});

it("an older completed PERSONAL checkpoint restarts replay and keeps reconciliation gated", async () => {
  await deletedSnapshot();
  for (let slot = 0; slot < 4; slot++) await restoreStep(slot);
  const current = await dbs.PUBLIC_AGGREGATE_DB.prepare(
    "SELECT intent_version FROM privacy_fence",
  ).first<{ intent_version: number }>();
  expect(current).not.toBeNull();
  const olderVersion = current!.intent_version - 1;
  // Actually roll back the completed checkpoint, not just restore the deleted account.
  await dbs.PERSONAL_DB.prepare(
    "UPDATE restore_replay SET intent_version = ?, cursor = 'older', page = NULL, complete = 1",
  )
    .bind(olderVersion)
    .run();
  expect(
    await dbs.PERSONAL_DB.prepare("SELECT intent_version, complete FROM restore_replay").first(),
  ).toEqual({ intent_version: olderVersion, complete: 1 });
  await admitAccount(
    dbs.PERSONAL_DB,
    { issuer: "https://accounts.google.com", sub: "restored" },
    "restored",
    NOW,
  );
  await dbs.PERSONAL_DB.prepare(
    "INSERT INTO self_percentiles VALUES ('restored', 'restored-again', 'R', '{}')",
  ).run();
  for (let slot = 4; slot < 8; slot++) {
    await restoreStep(slot);
    expect(await restoreGate()).toEqual({
      reconciliation_gate: Number(slot < 7),
      pending_intents: 0,
      blocked: 1,
    });
    expect(
      await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT intent_version FROM privacy_fence").first(),
    ).toEqual({ intent_version: olderVersion + 2 });
    expect(
      await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM self_percentiles").first(),
    ).toEqual({ n: 0 });
  }
  expect(await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM accounts").first()).toEqual({
    n: 0,
  });
  expect(await restoreGate()).toEqual({ reconciliation_gate: 0, pending_intents: 0, blocked: 1 });
});

it.each([
  { PRIVACY_RECONCILE_QUIESCENT: "false", PUBLICATION_ENABLED: "false" },
  { PRIVACY_RECONCILE_QUIESCENT: "true", PUBLICATION_ENABLED: "true" },
])("lane 5 does not replay outside disabled-publication maintenance: %j", async (flags) => {
  await deletedSnapshot();
  const measured = measure(flags);
  await worker.scheduled({ scheduledTime: laneTime(5) }, measured.env);
  expect(measured.count()).toBe(3);
  expect(await restoreGate()).toEqual({ reconciliation_gate: 0, pending_intents: 0, blocked: 1 });
  for (const table of ["accounts", "self_percentiles"]) {
    expect(await dbs.PERSONAL_DB.prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({
      n: 1,
    });
  }
  expect(await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM restore_replay").first()).toEqual(
    { n: 0 },
  );
});

it("multi-page restore replay resumes across :50 invocations and preserves newer withdrawal consent", async () => {
  for (const userId of ["u000", "u001", "u150"]) {
    await admitAccount(
      dbs.PERSONAL_DB,
      { issuer: "https://accounts.google.com", sub: userId },
      userId,
      NOW,
    );
  }
  await dbs.PERSONAL_DB.prepare("UPDATE accounts SET public_participation = 1").run();
  await dbs.PERSONAL_DB.prepare(
    "INSERT INTO self_percentiles VALUES ('u001', 'restored', 'R', '{}')",
  ).run();
  await dbs.PRIVACY_CONTROL_DB.batch(
    Array.from({ length: 151 }, (_, index) =>
      dbs.PRIVACY_CONTROL_DB.prepare(
        "INSERT INTO tombstones (user_id, kind, created_at, fence_generation) VALUES (?, ?, ?, 1)",
      ).bind(`u${String(index).padStart(3, "0")}`, index < 2 ? "withdrawal" : "deletion", NOW),
    ),
  );
  await dbs.PRIVACY_CONTROL_DB.prepare(
    `INSERT INTO consent_decisions
     (user_id, participation, decision_version, decided_at, fence_generation)
     VALUES ('u001', 1, 2, ?, 2)`,
  )
    .bind(NOW)
    .run();
  for (let slot = 0; slot < 6; slot++) {
    await restoreStep(slot);
    expect(await restoreGate()).toEqual({
      reconciliation_gate: Number(slot < 5),
      pending_intents: 0,
      blocked: 1,
    });
    if (slot === 2) {
      expect(
        await dbs.PERSONAL_DB.prepare("SELECT cursor, page, complete FROM restore_replay").first(),
      ).toEqual({ cursor: "u149", page: null, complete: 0 });
      expect(
        await dbs.PERSONAL_DB.prepare(
          "SELECT user_id FROM accounts WHERE user_id = 'u150'",
        ).first(),
      ).toEqual({ user_id: "u150" });
    }
  }
  expect(
    (
      await dbs.PERSONAL_DB.batch([
        dbs.PERSONAL_DB.prepare(
          "SELECT user_id, public_participation FROM accounts ORDER BY user_id",
        ),
      ])
    )[0]?.results,
  ).toEqual([
    { user_id: "u000", public_participation: 0 },
    { user_id: "u001", public_participation: 1 },
  ]);
  expect(
    await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM self_percentiles").first(),
  ).toEqual({ n: 0 });
});

it("a failed replay batch keeps its checkpoint and gate closed for the next :50 retry", async () => {
  await deletedSnapshot();
  await restoreStep(0);
  await restoreStep(1);
  await restoreStep(2, "UPDATE accounts SET public_participation");
  expect(await restoreGate()).toEqual({ reconciliation_gate: 1, pending_intents: 0, blocked: 1 });
  expect(
    await dbs.PERSONAL_DB.prepare("SELECT cursor, complete FROM restore_replay").first(),
  ).toEqual({ cursor: "", complete: 0 });
  expect(await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM accounts").first()).toEqual({
    n: 1,
  });
  await restoreStep(3);
  await restoreStep(4);
  expect(await restoreGate()).toEqual({ reconciliation_gate: 0, pending_intents: 0, blocked: 1 });
});

it.each([3, 4])(
  "a recovery admission after %i restore slots restarts completed replay",
  async (slots) => {
    await deletedSnapshot();
    for (let slot = 0; slot < slots; slot++) await restoreStep(slot);
    await applyPrivacyChange(
      maintenance,
      { userId: "earlier", opId: "late-delete", kind: "deletion" },
      NOW,
    );
    await admitAccount(
      dbs.PERSONAL_DB,
      { issuer: "https://accounts.google.com", sub: "earlier" },
      "earlier",
      NOW,
    );
    await restoreStep(slots);
    expect(await restoreGate()).toEqual({ reconciliation_gate: 1, pending_intents: 0, blocked: 1 });
    expect(
      await dbs.PERSONAL_DB.prepare("SELECT cursor, complete FROM restore_replay").first(),
    ).toEqual({ cursor: "", complete: 0 });
    for (let slot = slots + 1; slot < slots + 4; slot++) await restoreStep(slot);
    expect(await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM accounts").first()).toEqual({
      n: 0,
    });
    expect(await restoreGate()).toEqual({ reconciliation_gate: 0, pending_intents: 0, blocked: 1 });
  },
);
