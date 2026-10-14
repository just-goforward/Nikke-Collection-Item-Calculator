import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { inactivityDeadline, runInactivityDeletion } from "./inactivity";
import { admitAccount } from "./store";
import { resetFixture, type FixtureEnv } from "./test-fixture";
import type { PersonalEnv } from "./types";

const dbs = env as unknown as FixtureEnv;
const LAST = Date.UTC(2024, 2, 1, 12);
const DUE = Date.UTC(2026, 2, 1, 12);
beforeEach(() => resetFixture(dbs));

async function seed(id: string, active = LAST) {
  expect(await admitAccount(dbs.PERSONAL_DB,
    { issuer: "https://accounts.google.com", sub: id }, id, active)).toEqual({ userId: id });
}
async function accounts() {
  return (await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM accounts").first<{ n: number }>())?.n;
}

it("deletes at exactly two calendar years, not one millisecond earlier, without requiring warning", async () => {
  await seed("due");
  await runInactivityDeletion(dbs, DUE - 1);
  expect(await accounts()).toBe(1);
  await runInactivityDeletion(dbs, DUE);
  expect(await accounts()).toBe(0);
  expect(await admitAccount(dbs.PERSONAL_DB,
    { issuer: "https://accounts.google.com", sub: "due" }, "fresh", DUE)).toEqual({ userId: "fresh" });
});

it("clips a leap-day anniversary to February 28 while preserving UTC time", async () => {
  const leap = Date.UTC(2024, 1, 29, 23, 59, 59, 123);
  expect(inactivityDeadline(leap)).toBe(Date.UTC(2026, 1, 28, 23, 59, 59, 123));
  await seed("leap", leap);
  await runInactivityDeletion(dbs, inactivityDeadline(leap));
  expect(await accounts()).toBe(0);
});

it("isolates failed candidates, limits work to five and preserves an active account", async () => {
  for (let i = 0; i < 6; i++) await seed(`due-${i}`, LAST - i);
  await seed("active", DUE);
  const privacy = dbs.PRIVACY_CONTROL_DB;
  const unavailable: PersonalEnv = { ...dbs, PRIVACY_CONTROL_DB: {
    prepare(sql) {
      if (sql.startsWith("INSERT INTO privacy_operations")) throw new Error("local_failure");
      return privacy.prepare(sql);
    },
    batch: (statements) => privacy.batch(statements),
    exec: (sql) => privacy.exec(sql),
  } };
  await runInactivityDeletion(unavailable, DUE);
  expect((await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM deletion_jobs")
    .first<{ n: number }>())?.n).toBe(5);
  expect((await dbs.PERSONAL_DB.prepare("SELECT blocked FROM accounts WHERE user_id = 'active'")
    .first<{ blocked: number }>())?.blocked).toBe(0);
});

it("a login/save activity update after selection wins the atomic deletion guard", async () => {
  await seed("race");
  const publicDb = dbs.PUBLIC_AGGREGATE_DB;
  const raced: PersonalEnv = { ...dbs, PUBLIC_AGGREGATE_DB: {
    prepare: (sql) => publicDb.prepare(sql),
    async batch(statements) {
      await dbs.PERSONAL_DB.prepare("UPDATE accounts SET last_active_at = ? WHERE user_id = 'race'")
        .bind(DUE).run();
      return publicDb.batch(statements);
    },
    exec: (sql) => publicDb.exec(sql),
  } };
  await runInactivityDeletion(raced, DUE);
  expect(await accounts()).toBe(1);
  expect((await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM deletion_jobs")
    .first<{ n: number }>())?.n).toBe(0);
});
