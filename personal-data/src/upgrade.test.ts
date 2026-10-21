import { expect, it } from "vitest";
import { readSession, SESSION_IDLE_MS, SESSION_MAX_MS, sha256 } from "./auth";
import { fixtureEnv, migrateFixture, resetFixture } from "./test-fixture";
import type { SqlDatabase } from "./types";

const dbs = fixtureEnv();
const NOW = Date.UTC(2026, 8, 2);
const DAY = 86_400_000;

async function rows(db: SqlDatabase, queries: string[]) {
  return (await db.batch(queries.map((sql) => db.prepare(sql)))).map((result) => result.results);
}

it("upgrades populated M1 stores preserving user content and authority while resetting beta derived ranks", async () => {
  await resetFixture({
    ...dbs,
    PERSONAL_MIGRATIONS: dbs.PERSONAL_MIGRATIONS.slice(0, 1),
    PRIVACY_MIGRATIONS: dbs.PRIVACY_MIGRATIONS.slice(0, 1),
    PUBLIC_MIGRATIONS: dbs.PUBLIC_MIGRATIONS.slice(0, 1),
  });
  const rawActive = "ab".repeat(32);
  const rawExpired = "cd".repeat(32);
  const activeHash = await sha256(rawActive);
  const expiredHash = await sha256(rawExpired);
  const summary = {
    itemId: "item",
    stage: "R",
    lifetimeAttempts: 2,
    lifetimeIncome: 3,
    preSignupIncome: 1,
    manualEntry: true,
    verified: false,
  };
  const document = JSON.stringify({ schemaVersion: 1, items: ["一😀"], lifetimeStages: [summary] });
  const archive = JSON.stringify({
    archiveId: "old-archive",
    summary,
    startedAt: NOW - DAY,
    completedAt: NOW,
  });
  const rank = JSON.stringify({
    releaseId: "old-release",
    stage: "R",
    percentileBand: { lower: 40, upper: 50 },
    manualEntry: true,
    verified: false,
  });
  await dbs.PERSONAL_DB.batch([
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO accounts (user_id, created_at, last_active_at) VALUES ('upgrade-user', ?, ?)",
    ).bind(NOW - 10 * DAY, NOW),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO identities VALUES ('https://accounts.google.com', 'upgrade-sub', 'upgrade-user')",
    ),
    dbs.PERSONAL_DB.prepare("INSERT INTO sessions VALUES (?, 'upgrade-user', ?, ?, ?)").bind(
      activeHash,
      NOW - 10 * DAY,
      NOW + 20 * DAY,
      NOW + 80 * DAY,
    ),
    dbs.PERSONAL_DB.prepare("INSERT INTO sessions VALUES (?, 'upgrade-user', ?, ?, ?)").bind(
      expiredHash,
      NOW - 91 * DAY,
      NOW - 61 * DAY,
      NOW - DAY,
    ),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO workspaces VALUES ('upgrade-user', 7, 'old-op', 'old-nonce', ?)",
    ).bind(document),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO operations VALUES ('upgrade-user', 'old-op', ?, 7, 'save', ?)",
    ).bind(await sha256("old-request"), NOW),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO stage_summaries VALUES ('upgrade-user', 'item', 'R', ?)",
    ).bind(JSON.stringify(summary)),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO pending_archives VALUES ('upgrade-user', 'old-archive', ?, ?)",
    ).bind(archive, NOW),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO self_percentiles VALUES ('upgrade-user', 'old-release', 'R', ?)",
    ).bind(rank),
    ...[null, NOW].map((consumed, index) =>
      dbs.PERSONAL_DB.prepare(
        "INSERT INTO oauth_transactions VALUES (?, ?, 'old-verifier', '/', ?, ?, ?)",
      ).bind(String(index).repeat(64), "f".repeat(64), NOW, NOW + 600_000, consumed),
    ),
  ]);
  await dbs.PRIVACY_CONTROL_DB.batch([
    dbs.PRIVACY_CONTROL_DB.prepare(
      "INSERT INTO consent_decisions VALUES ('upgrade-user', 0, 3, ?)",
    ).bind(NOW),
    dbs.PRIVACY_CONTROL_DB.prepare(
      "INSERT INTO tombstones VALUES ('deleted-old-user', 'deletion', ?, ?, 8)",
    ).bind(await sha256("old-identity"), NOW),
    dbs.PRIVACY_CONTROL_DB.prepare(
      "INSERT INTO privacy_operations VALUES ('old-delete', 'deleted-old-user', 'deletion', 8, 'complete', ?)",
    ).bind(NOW),
  ]);
  await dbs.PUBLIC_AGGREGATE_DB.batch([
    dbs.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET generation = 8, blocked = 0"),
    dbs.PUBLIC_AGGREGATE_DB.prepare(
      "INSERT INTO weekly_releases VALUES ('old-release', '2026-08-31', 8, '{\"cells\":[]}', ?)",
    ).bind(NOW),
    dbs.PUBLIC_AGGREGATE_DB.prepare(
      "INSERT INTO disclosure_history VALUES ('old-release', '2026-08-31', 8, 'old-policy', ?, NULL)",
    ).bind(NOW),
    dbs.PUBLIC_AGGREGATE_DB.prepare(
      "UPDATE current_release SET release_id = 'old-release', fence_generation = 8",
    ),
    dbs.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET blocked = 1"),
  ]);
  const personal = [
    "SELECT user_id, created_at, last_active_at, quota_bytes, public_participation FROM accounts",
    "SELECT * FROM identities",
    "SELECT token_hash, user_id, created_at, idle_expires_at, max_expires_at FROM sessions ORDER BY token_hash",
    "SELECT * FROM workspaces",
    "SELECT * FROM operations",
    "SELECT * FROM stage_summaries",
    "SELECT * FROM pending_archives",
  ];
  const privacy = [
    "SELECT user_id, participation, decision_version, decided_at FROM consent_decisions",
    "SELECT user_id, kind, created_at, fence_generation FROM tombstones",
    "SELECT * FROM privacy_operations",
  ];
  const publicQueries = [
    "SELECT singleton, generation, blocked FROM privacy_fence",
    "SELECT * FROM current_release",
    "SELECT release_id, week_start, fence_generation, payload, published_at FROM weekly_releases",
    "SELECT * FROM disclosure_history",
  ];
  const before = await Promise.all([
    rows(dbs.PERSONAL_DB, personal),
    rows(dbs.PRIVACY_CONTROL_DB, privacy),
    rows(dbs.PUBLIC_AGGREGATE_DB, publicQueries),
  ]);
  // Independent stores: preserve privacy authority first; no account DB restore can roll it back.
  await migrateFixture(dbs.PRIVACY_CONTROL_DB, dbs.PRIVACY_MIGRATIONS);
  await migrateFixture(dbs.PERSONAL_DB, dbs.PERSONAL_MIGRATIONS);
  await migrateFixture(dbs.PUBLIC_AGGREGATE_DB, dbs.PUBLIC_MIGRATIONS);
  expect(
    await Promise.all([
      rows(dbs.PERSONAL_DB, personal),
      rows(dbs.PRIVACY_CONTROL_DB, privacy),
      rows(dbs.PUBLIC_AGGREGATE_DB, publicQueries),
    ]),
  ).toEqual(before);
  expect(
    await dbs.PERSONAL_DB.prepare("SELECT count(*) AS n FROM self_percentiles").first(),
  ).toEqual({ n: 0 });
  expect(
    await dbs.PERSONAL_DB.prepare(
      "SELECT inactivity_retry_after FROM accounts WHERE user_id = 'upgrade-user'",
    ).first(),
  ).toEqual({ inactivity_retry_after: 0 });
  expect(await readSession(dbs.PERSONAL_DB, rawActive, NOW)).toMatchObject({
    userId: "upgrade-user",
    authEpoch: 0,
  });
  expect(await readSession(dbs.PERSONAL_DB, rawExpired, NOW)).toBeNull();
  expect(await readSession(dbs.PERSONAL_DB, rawActive, NOW + 20 * DAY)).toBeNull();
  const session = (
    await rows(dbs.PERSONAL_DB, [
      `SELECT max_expires_at - created_at AS absolute_ms, idle_expires_at - created_at AS idle_ms
     FROM sessions WHERE token_hash = '${activeHash}'`,
    ])
  )[0]?.[0];
  expect(session).toEqual({ absolute_ms: SESSION_MAX_MS, idle_ms: SESSION_IDLE_MS });
  expect(
    (await rows(dbs.PERSONAL_DB, ["SELECT count(*) AS n FROM oauth_transactions"]))[0]?.[0],
  ).toEqual({ n: 0 });
  const columns = (await rows(dbs.PRIVACY_CONTROL_DB, ["PRAGMA table_info(tombstones)"]))[0] ?? [];
  expect(columns.some((row) => row["name"] === "identity_hash")).toBe(false);
  expect(
    (await rows(dbs.PRIVACY_CONTROL_DB, ["SELECT count(*) AS n FROM d1_migrations"]))[0]?.[0],
  ).toEqual({ n: 4 });
  expect(
    (await rows(dbs.PERSONAL_DB, ["SELECT count(*) AS n FROM d1_migrations"]))[0]?.[0],
  ).toEqual({ n: 9 });
});

it("upgrades populated 0002 through 0003 and 0004 without losing records or pending deletion work", async () => {
  await resetFixture({
    ...dbs,
    PERSONAL_MIGRATIONS: dbs.PERSONAL_MIGRATIONS.slice(0, 2),
    PRIVACY_MIGRATIONS: dbs.PRIVACY_MIGRATIONS.slice(0, 2),
  });
  const raw = "ef".repeat(32);
  const tokenHash = await sha256(raw);
  const legacyHash = await sha256("legacy-v2-deletion");
  await dbs.PERSONAL_DB.batch([
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO accounts (user_id, created_at, last_active_at) VALUES ('active-v2', ?, ?)",
    ).bind(NOW, NOW),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO accounts (user_id, created_at, last_active_at, auth_epoch, blocked) VALUES ('deleted-v2', ?, ?, 1, 1)",
    ).bind(NOW, NOW),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO identities VALUES ('https://accounts.google.com', 'active-v2', 'active-v2')",
    ),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO identities VALUES ('https://accounts.google.com', 'gone-v2', 'deleted-v2')",
    ),
    dbs.PERSONAL_DB.prepare("INSERT INTO sessions VALUES (?, 'active-v2', ?, ?, ?, 0)").bind(
      tokenHash,
      NOW,
      NOW + SESSION_IDLE_MS,
      NOW + SESSION_MAX_MS,
    ),
    dbs.PERSONAL_DB.prepare(
      `INSERT INTO workspaces VALUES ('active-v2', 2, 'op-v2', 'write-v2',
       '{"schemaVersion":1,"items":["一😀"],"lifetimeStages":[]}')`,
    ),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO operations VALUES ('active-v2', 'op-v2', ?, 2, 'save', ?)",
    ).bind(await sha256("request-v2"), NOW),
    dbs.PERSONAL_DB.prepare("INSERT INTO blocked_identities VALUES (?, ?)").bind(legacyHash, NOW),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO deletion_jobs VALUES ('deleted-v2', 'del-v2', ?, ?, 5)",
    ).bind(legacyHash, NOW),
    dbs.PERSONAL_DB.prepare(
      "INSERT INTO oauth_transactions VALUES (?, ?, 'verifier-v2', '/', ?, ?, 'nonce-v2', 1)",
    ).bind("a".repeat(64), "b".repeat(64), NOW, NOW + 600_000),
    dbs.PERSONAL_DB.prepare("UPDATE auth_control SET epoch = 1"),
  ]);
  await dbs.PRIVACY_CONTROL_DB.batch([
    dbs.PRIVACY_CONTROL_DB.prepare(
      "INSERT INTO consent_decisions VALUES ('active-v2', 1, 2, ?, 5, 'consent-v2')",
    ).bind(NOW),
    dbs.PRIVACY_CONTROL_DB.prepare(
      "INSERT INTO consent_operations VALUES ('active-v2', 'consent-v2', ?, 2, 5)",
    ).bind(await sha256("consent-v2")),
    dbs.PRIVACY_CONTROL_DB.prepare(
      "INSERT INTO tombstones VALUES ('historical-v2', 'deletion', ?, ?, 5)",
    ).bind(legacyHash, NOW),
    dbs.PRIVACY_CONTROL_DB.prepare(
      "INSERT INTO privacy_operations VALUES ('del-v2', 'deleted-v2', 'deletion', 5, 'pending', ?)",
    ).bind(NOW),
  ]);
  await dbs.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET generation = 5").run();
  const personal = [
    "SELECT user_id, created_at, last_active_at, quota_bytes, public_participation, auth_epoch, blocked FROM accounts ORDER BY user_id",
    "SELECT * FROM identities ORDER BY user_id",
    "SELECT * FROM sessions",
    "SELECT * FROM workspaces",
    "SELECT * FROM operations",
    "SELECT user_id, op_id, created_at, fence_generation FROM deletion_jobs",
    "SELECT * FROM auth_control",
  ];
  const privacy = [
    "SELECT * FROM consent_decisions",
    "SELECT * FROM consent_operations",
    "SELECT user_id, kind, created_at, fence_generation FROM tombstones",
    "SELECT * FROM privacy_operations",
  ];
  const publicQueries = [
    "SELECT singleton, generation, blocked FROM privacy_fence",
    "SELECT * FROM current_release",
  ];
  const before = await Promise.all([
    rows(dbs.PERSONAL_DB, personal),
    rows(dbs.PRIVACY_CONTROL_DB, privacy),
    rows(dbs.PUBLIC_AGGREGATE_DB, publicQueries),
  ]);
  await migrateFixture(dbs.PRIVACY_CONTROL_DB, dbs.PRIVACY_MIGRATIONS);
  await migrateFixture(dbs.PERSONAL_DB, dbs.PERSONAL_MIGRATIONS);
  expect(
    await Promise.all([
      rows(dbs.PERSONAL_DB, personal),
      rows(dbs.PRIVACY_CONTROL_DB, privacy),
      rows(dbs.PUBLIC_AGGREGATE_DB, publicQueries),
    ]),
  ).toEqual(before);
  expect(await readSession(dbs.PERSONAL_DB, raw, NOW)).toMatchObject({
    userId: "active-v2",
    authEpoch: 0,
  });
  expect(
    (await rows(dbs.PERSONAL_DB, ["SELECT count(*) AS n FROM oauth_transactions"]))[0]?.[0],
  ).toEqual({ n: 0 });
  expect((await rows(dbs.PERSONAL_DB, ["SELECT retry_after FROM deletion_jobs"]))[0]?.[0]).toEqual({
    retry_after: 0,
  });
});

it("PUBLIC 0002 preserves populated releases with eligible defaults and enforces its new triggers", async () => {
  await resetFixture({ ...dbs, PUBLIC_MIGRATIONS: dbs.PUBLIC_MIGRATIONS.slice(0, 1) });
  await dbs.PUBLIC_AGGREGATE_DB.batch([
    dbs.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET blocked = 0, generation = 8"),
    dbs.PUBLIC_AGGREGATE_DB.prepare(
      `INSERT INTO weekly_releases VALUES ('populated-public', '2026-08-31', 8, '{"cells":[]}', ?)`,
    ).bind(NOW),
    dbs.PUBLIC_AGGREGATE_DB.prepare(
      "UPDATE current_release SET release_id = 'populated-public', fence_generation = 8",
    ),
    dbs.PUBLIC_AGGREGATE_DB.prepare(
      "INSERT INTO disclosure_history VALUES ('populated-public', '2026-08-31', 8, 'old', ?, NULL)",
    ).bind(NOW),
  ]);
  await migrateFixture(dbs.PUBLIC_AGGREGATE_DB, dbs.PUBLIC_MIGRATIONS.slice(0, 2));
  expect(
    await dbs.PUBLIC_AGGREGATE_DB.prepare(
      "SELECT state, intent_version, payload FROM weekly_releases WHERE release_id = 'populated-public'",
    ).first(),
  ).toEqual({ state: "published", intent_version: 0, payload: '{"cells":[]}' });
  expect(
    await dbs.PUBLIC_AGGREGATE_DB.prepare(
      "SELECT pending_intents, intent_version, publisher_token, activated_token FROM privacy_fence",
    ).first(),
  ).toEqual({
    pending_intents: 0,
    intent_version: 0,
    publisher_token: null,
    activated_token: null,
  });
  expect(
    await dbs.PUBLIC_AGGREGATE_DB.prepare(
      "SELECT release_id, fence_generation FROM current_release",
    ).first(),
  ).toEqual({ release_id: "populated-public", fence_generation: 8 });
  expect(
    await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT invalidated_at FROM disclosure_history").first(),
  ).toEqual({ invalidated_at: null });
  await dbs.PUBLIC_AGGREGATE_DB.prepare(
    "UPDATE privacy_fence SET pending_intents = 1, intent_version = 1",
  ).run();
  await expect(
    dbs.PUBLIC_AGGREGATE_DB.prepare(
      `INSERT INTO weekly_releases (release_id, week_start, fence_generation, payload, published_at)
     VALUES ('forbidden', '2026-09-07', 8, '{}', ?)`,
    )
      .bind(NOW)
      .run(),
  ).rejects.toThrow("privacy_fenced");
  await expect(
    dbs.PUBLIC_AGGREGATE_DB.prepare(
      "UPDATE current_release SET release_id = 'populated-public'",
    ).run(),
  ).rejects.toThrow("privacy_fenced");
  await expect(
    dbs.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET intent_version = 0").run(),
  ).rejects.toThrow("intent_regression");
});
