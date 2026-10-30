import { beforeEach, expect, it } from "vitest";
import { inactivityDeadline, runInactivityDeletion } from "./inactivity";
import { admitAccount } from "./store";
import { fixtureEnv, resetFixture } from "./test-fixture";
import type { PersonalEnv, SqlStatement } from "./types";

const dbs = fixtureEnv();
const LAST = Date.UTC(2024, 2, 1, 12);
const DUE = Date.UTC(2026, 2, 1, 12);
beforeEach(() => resetFixture(dbs));

async function seed(id: string, active = LAST) {
  expect(
    await admitAccount(
      dbs.PERSONAL_DB,
      { issuer: "https://accounts.google.com", sub: id },
      id,
      active,
    ),
  ).toEqual({ userId: id });
}
async function accounts() {
  return (
    await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM accounts").first<{ n: number }>()
  )?.n;
}

it("deletes at exactly two calendar years, not one millisecond earlier, without requiring warning", async () => {
  await seed("due");
  await runInactivityDeletion(dbs, DUE - 1);
  expect(await accounts()).toBe(1);
  await runInactivityDeletion(dbs, DUE);
  expect(await accounts()).toBe(0);
  expect(
    await admitAccount(
      dbs.PERSONAL_DB,
      { issuer: "https://accounts.google.com", sub: "due" },
      "fresh",
      DUE,
    ),
  ).toEqual({ userId: "fresh" });
});

it("clips a leap-day anniversary to February 28 while preserving UTC time", async () => {
  const leap = Date.UTC(2024, 1, 29, 23, 59, 59, 123);
  expect(inactivityDeadline(leap)).toBe(Date.UTC(2026, 1, 28, 23, 59, 59, 123));
  await seed("leap", leap);
  await runInactivityDeletion(dbs, inactivityDeadline(leap));
  expect(await accounts()).toBe(0);
});

it("isolates failed candidates, limits work to one and preserves an active account", async () => {
  for (let i = 0; i < 6; i++) await seed(`due-${i}`, LAST - i);
  await seed("active", DUE);
  const privacy = dbs.PRIVACY_CONTROL_DB;
  const unavailable: PersonalEnv = {
    ...dbs,
    PRIVACY_CONTROL_DB: {
      prepare(sql) {
        if (sql.startsWith("INSERT INTO privacy_operations")) throw new Error("local_failure");
        return privacy.prepare(sql);
      },
      batch: (statements) => privacy.batch(statements),
      exec: (sql) => privacy.exec(sql),
    },
  };
  await runInactivityDeletion(unavailable, DUE);
  expect(
    (
      await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM deletion_jobs").first<{
        n: number;
      }>()
    )?.n,
  ).toBe(1);
  expect(
    (
      await dbs.PERSONAL_DB.prepare("SELECT blocked FROM accounts WHERE user_id = 'active'").first<{
        blocked: number;
      }>()
    )?.blocked,
  ).toBe(0);
});

it("a login/save activity update after selection wins the atomic deletion guard", async () => {
  await seed("race");
  await dbs.PUBLIC_AGGREGATE_DB.batch([
    dbs.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET blocked = 0"),
    dbs.PUBLIC_AGGREGATE_DB.prepare(
      `INSERT INTO weekly_releases (release_id, week_start, fence_generation, payload, published_at)
       VALUES ('keep-release', '2026-02-23', 0, '{"cells":[]}', ?)`,
    ).bind(DUE),
    dbs.PUBLIC_AGGREGATE_DB.prepare("UPDATE current_release SET release_id = 'keep-release'"),
  ]);
  const personalDb = dbs.PERSONAL_DB;
  let selection = true;
  const raced: PersonalEnv = {
    ...dbs,
    PERSONAL_DB: {
      prepare: (sql) => personalDb.prepare(sql),
      async batch<T>(statements: SqlStatement[]) {
        const result = await personalDb.batch<T>(statements);
        if (selection) {
          selection = false;
          await dbs.PERSONAL_DB.prepare(
            "UPDATE accounts SET last_active_at = ? WHERE user_id = 'race'",
          )
            .bind(DUE)
            .run();
        }
        return result;
      },
      exec: (sql) => personalDb.exec(sql),
    },
  };
  await runInactivityDeletion(raced, DUE);
  expect(await accounts()).toBe(1);
  expect(
    (
      await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM deletion_jobs").first<{
        n: number;
      }>()
    )?.n,
  ).toBe(0);
  expect(
    await dbs.PUBLIC_AGGREGATE_DB.prepare(
      "SELECT generation, blocked, pending_intents FROM privacy_fence",
    ).first(),
  ).toEqual({ generation: 0, blocked: 0, pending_intents: 0 });
  expect(
    await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT release_id FROM current_release").first(),
  ).toEqual({ release_id: "keep-release" });
});

it("backs off an unblocked failing candidate and processes other candidates even after retry becomes due", async () => {
  await seed("first", LAST - 1);
  await seed("second");
  const publicDb = dbs.PUBLIC_AGGREGATE_DB;
  const unavailable: PersonalEnv = {
    ...dbs,
    PUBLIC_AGGREGATE_DB: {
      prepare(sql) {
        if (sql.startsWith("INSERT INTO privacy_intents")) throw new Error("admission_outage");
        return publicDb.prepare(sql);
      },
      batch: (statements) => publicDb.batch(statements),
      exec: (sql) => publicDb.exec(sql),
    },
  };
  await runInactivityDeletion(unavailable, DUE);
  expect(
    await dbs.PERSONAL_DB.prepare(
      "SELECT blocked, inactivity_retry_after FROM accounts WHERE user_id = 'first'",
    ).first(),
  ).toEqual({ blocked: 0, inactivity_retry_after: DUE + 60_000 });
  expect(await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM deletion_jobs").first()).toEqual({
    n: 0,
  });
  // At the next hourly lane, both are due: never-attempted second still goes first.
  await runInactivityDeletion(dbs, DUE + 3_600_000);
  expect(await dbs.PERSONAL_DB.prepare("SELECT user_id FROM accounts").first()).toEqual({
    user_id: "first",
  });
  await runInactivityDeletion(dbs, DUE + 3_600_000);
  expect(await accounts()).toBe(0);
});

it("does not retry a lone failed candidate before its backoff expires", async () => {
  await seed("retry");
  const publicDb = dbs.PUBLIC_AGGREGATE_DB;
  await runInactivityDeletion(
    {
      ...dbs,
      PUBLIC_AGGREGATE_DB: {
        prepare() {
          throw new Error("pre_block_outage");
        },
        batch: (statements) => publicDb.batch(statements),
        exec: (sql) => publicDb.exec(sql),
      },
    },
    DUE,
  );
  await runInactivityDeletion(dbs, DUE + 59_999);
  expect(await accounts()).toBe(1);
  await runInactivityDeletion(dbs, DUE + 60_000);
  expect(await accounts()).toBe(0);
});

it.each([
  { now: DUE, future: LAST + 12 * 3_600_000, overdue: LAST - 1 },
  {
    now: Date.UTC(2026, 1, 28, 12),
    future: Date.UTC(2024, 1, 28, 18),
    overdue: Date.UTC(2024, 1, 29, 11),
  },
])(
  "an ineligible never-attempted candidate cannot obstruct an eligible expired retry at $now",
  async ({ now, future, overdue }) => {
    await seed("never-attempted", future);
    await seed("expired-retry", overdue);
    await dbs.PERSONAL_DB.prepare(
      "UPDATE accounts SET inactivity_retry_after = ? WHERE user_id = 'expired-retry'",
    )
      .bind(now - 1)
      .run();
    expect(inactivityDeadline(future)).toBeGreaterThan(now);
    expect(inactivityDeadline(overdue)).toBeLessThan(now);
    await runInactivityDeletion(dbs, now);
    expect(await dbs.PERSONAL_DB.prepare("SELECT user_id, blocked FROM accounts").first()).toEqual({
      user_id: "never-attempted",
      blocked: 0,
    });
  },
);

it("on a leap-day now includes the entire due source February 28, not just its current UTC time", async () => {
  const now = Date.UTC(2028, 1, 29);
  const active = Date.UTC(2026, 1, 28, 23, 59, 59, 999);
  await seed("due-yesterday", active);
  expect(inactivityDeadline(active)).toBe(Date.UTC(2028, 1, 28, 23, 59, 59, 999));
  await runInactivityDeletion(dbs, now);
  expect(await accounts()).toBe(0);
});
