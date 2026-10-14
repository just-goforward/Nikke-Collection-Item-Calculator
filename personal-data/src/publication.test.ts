import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { applyPrivacyChange, withPrivacyIntent } from "./privacy";
import { publishWeekly, weekStart } from "./publication";
import { admitAccount, EMPTY_DOCUMENT } from "./store";
import { resetFixture, type FixtureEnv } from "./test-fixture";
import type { PublicStatistics } from "./contracts";
import type { PersonalEnv } from "./types";
import worker from "./worker";

const dbs = env as unknown as FixtureEnv;
const NOW = Date.UTC(2026, 8, 2, 12);
const enabled: PersonalEnv = { ...dbs, PUBLICATION_ENABLED: "true", SITE_ORIGIN: "https://local",
  GOOGLE_CLIENT_ID: "local", GOOGLE_CLIENT_SECRET: "local-only-test-value" };
beforeEach(() => resetFixture(dbs));

async function seed(
  count = 10, participant = true, prefix = "member", manual = false, verified = false,
  lifetime = 200, preSignup = 100,
) {
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`;
    await admitAccount(dbs.PERSONAL_DB, { issuer: "https://accounts.google.com", sub: id }, id, NOW);
    const summary = { itemId: "item", stage: "R", lifetimeAttempts: 20,
      lifetimeIncome: lifetime, preSignupIncome: preSignup, manualEntry: manual, verified };
    await dbs.PERSONAL_DB.batch([
      dbs.PERSONAL_DB.prepare("INSERT INTO stage_summaries VALUES (?, 'item', 'R', ?)")
        .bind(id, JSON.stringify(summary)),
      dbs.PERSONAL_DB.prepare("UPDATE workspaces SET document = ? WHERE user_id = ?")
        .bind(JSON.stringify({ ...EMPTY_DOCUMENT, lifetimeStages: [summary] }), id),
    ]);
    if (participant) await dbs.PRIVACY_CONTROL_DB.prepare(
      "INSERT INTO consent_decisions (user_id, participation, decision_version, decided_at) VALUES (?, 1, 1, ?)",
    ).bind(id, NOW).run();
  }
}
async function release(): Promise<PublicStatistics | null> {
  const result = await worker.fetch(new Request("https://local/v1/statistics"), enabled);
  return result.status === 200 ? await result.json() as PublicStatistics : null;
}
async function fence() {
  return dbs.PUBLIC_AGGREGATE_DB.prepare(
    "SELECT generation, blocked, pending_intents, publisher_token FROM privacy_fence",
  ).first<{ generation: number; blocked: number; pending_intents: number; publisher_token: string | null }>();
}

it("publication is disabled by default and does not acquire or clear the fence", async () => {
  await seed();
  expect(await publishWeekly(dbs, NOW)).toBe("disabled");
  expect((await fence())?.blocked).toBe(1);
  expect((await fence())?.publisher_token).toBeNull();
});

it("publishes opted-in unique accounts only, excludes pre-signup income and freezes private ranks", async () => {
  await seed();
  await seed(1, false, "private", false, false, 50_000, 0);
  expect(weekStart(NOW)).toBe("2026-08-31");
  expect(await publishWeekly(enabled, NOW)).toBe("published");
  const published = await release();
  expect(published?.policy?.k).toBe(10);
  expect(published?.cells).toHaveLength(1);
  expect(published?.cells[0]?.cohort).toBe("nonmanual_unverified");
  expect(published?.cells[0]?.bands[1]).toEqual({ lower: 100, upper: 200, count: 10 });
  expect(published?.cells[0]?.bands[2]?.count).toBe(0);
  expect(JSON.stringify(published)).not.toMatch(/member-|private-|userId|50_000|50000/);
  const originalRank = await dbs.PERSONAL_DB.prepare(
    "SELECT payload FROM self_percentiles WHERE user_id = 'member-0'",
  ).first<{ payload: string }>();
  await dbs.PERSONAL_DB.prepare(
    "UPDATE stage_summaries SET summary = json_set(summary, '$.lifetimeIncome', 900) WHERE user_id = 'member-0'",
  ).run();
  expect(await publishWeekly(enabled, NOW + 1_000)).toBe("unchanged");
  expect(await dbs.PERSONAL_DB.prepare(
    "SELECT payload FROM self_percentiles WHERE user_id = 'member-0'",
  ).first()).toEqual(originalRank);
  expect((await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT count(*) AS n FROM disclosure_history")
    .first<{ n: number }>())?.n).toBe(1);
  expect((await dbs.PERSONAL_DB.prepare(
    "SELECT count(*) AS n FROM self_percentiles WHERE user_id = 'private-0'",
  ).first<{ n: number }>())?.n).toBe(1);
});

it("suppresses k-minus-one cells and respects manual/client-verification cohorts with clamped tails", async () => {
  await seed(9, true, "small");
  await seed(10, true, "manual", true, false, 25_000, 0);
  await seed(10, true, "reported", false, true, 350, 0);
  expect(await publishWeekly(enabled, NOW)).toBe("published");
  const result = await release();
  expect(result?.cells.find((cell) => cell.cohort === "nonmanual_unverified"))
    .toMatchObject({ suppressed: true, bands: [] });
  const manual = result?.cells.find((cell) => cell.cohort === "manual_unverified");
  expect(manual?.bands[9]).toEqual({ lower: 900, upper: 1000, count: 10 });
  expect(result?.cells.find((cell) => cell.cohort === "nonmanual_self_reported_verified")?.bands[3]?.count)
    .toBe(10);
  expect(JSON.stringify(result)).not.toMatch(/25000|"min"|"max"/);
});

it("withdrawal invalidates the current release first; same-week rebuild excludes the withdrawn account", async () => {
  await seed();
  await publishWeekly(enabled, NOW);
  const old = await release();
  await applyPrivacyChange(dbs, { userId: "member-0", opId: "withdraw", kind: "withdrawal" }, NOW + 1);
  expect(await release()).toBeNull();
  expect((await fence())?.generation).toBe(1);
  expect(await publishWeekly(enabled, NOW + 2)).toBe("published");
  const next = await release();
  expect(next?.releaseId).not.toBe(old?.releaseId);
  expect(next?.cells[0]).toMatchObject({ suppressed: true, bands: [] });
  expect((await dbs.PUBLIC_AGGREGATE_DB.prepare(
    "SELECT invalidated_at FROM disclosure_history WHERE release_id = ?",
  ).bind(old?.releaseId ?? "").first<{ invalidated_at: number }>())?.invalidated_at).toBe(NOW + 1);
});

it("a privacy change between snapshot and activation prevents unblocking or pointer advancement", async () => {
  await seed();
  expect(await publishWeekly(enabled, NOW, {
    afterSnapshot: () => applyPrivacyChange(dbs,
      { userId: "member-0", opId: "delete-interleave", kind: "deletion" }, NOW + 1).then(() => undefined),
  })).toBe("blocked");
  expect(await release()).toBeNull();
  expect((await fence())?.blocked).toBe(1);
  expect((await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT release_id FROM current_release")
    .first<{ release_id: string | null }>())?.release_id).toBeNull();
});

it("a new pending privacy intent after snapshot prevents activation even before its decision/fence write", async () => {
  await seed();
  expect(await publishWeekly(enabled, NOW, {
    afterSelfRanks: async () => {
      await dbs.PUBLIC_AGGREGATE_DB.prepare(
        "UPDATE privacy_fence SET pending_intents = pending_intents + 1, intent_version = intent_version + 1",
      ).run();
    },
  })).toBe("blocked");
  expect((await fence())?.pending_intents).toBe(1);
  expect((await fence())?.blocked).toBe(1);
  expect(await release()).toBeNull();
});

it("publisher crashes retain the block/token and staged data is never served", async () => {
  await seed();
  await expect(publishWeekly(enabled, NOW, {
    afterSelfRanks: async () => { throw new Error("crash_canary"); },
  })).rejects.toThrow("crash_canary");
  expect((await fence())?.blocked).toBe(1);
  expect((await fence())?.publisher_token).not.toBeNull();
  expect(await release()).toBeNull();
  expect(await publishWeekly(enabled, NOW + 1)).toBe("blocked");
});

it("an unknown privacy failure retains its admission marker and blocks later publication", async () => {
  await seed();
  await expect(withPrivacyIntent(dbs, async () => { throw new Error("unknown_failure"); }))
    .rejects.toThrow("unknown_failure");
  expect((await fence())?.pending_intents).toBe(1);
  expect(await publishWeekly(enabled, NOW)).toBe("blocked");
});

it("private pending reservations and deletion jobs prevent publication without clearing the block", async () => {
  await seed();
  await dbs.PRIVACY_CONTROL_DB.prepare(
    `INSERT INTO consent_reservations
     (user_id, op_id, request_hash, base_revision, participation, write_nonce, created_at)
     VALUES ('member-0', 'pending', 'hash', 1, 0, 'nonce', ?)`,
  ).bind(NOW).run();
  expect(await publishWeekly(enabled, NOW)).toBe("blocked");
  expect((await fence())?.blocked).toBe(1);
});

it("isolates a pending deletion and never counts its blocked account", async () => {
  await seed();
  await dbs.PERSONAL_DB.batch([
    dbs.PERSONAL_DB.prepare("UPDATE accounts SET blocked = 1 WHERE user_id = 'member-0'"),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO deletion_jobs (user_id, op_id, created_at, fence_generation) VALUES ('member-0', 'pending-delete', ?, 0)",
    ).bind(NOW),
  ]);
  expect(await publishWeekly(enabled, NOW)).toBe("blocked");
  expect(await release()).toBeNull();
});

it("concurrent cold publishers produce one release and the next UTC week produces a new frozen release", async () => {
  await seed();
  const results = await Promise.all([publishWeekly(enabled, NOW), publishWeekly(enabled, NOW)]);
  expect(results.filter((value) => value === "published")).toHaveLength(1);
  expect((await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT count(*) AS n FROM disclosure_history")
    .first<{ n: number }>())?.n).toBe(1);
  expect(await publishWeekly(enabled, NOW + 7 * 86_400_000)).toBe("published");
  expect((await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT count(*) AS n FROM disclosure_history")
    .first<{ n: number }>())?.n).toBe(2);
  expect((await dbs.PERSONAL_DB.prepare(
    "SELECT count(*) AS n FROM self_percentiles WHERE user_id = 'member-0'",
  ).first<{ n: number }>())?.n).toBe(2);
});
