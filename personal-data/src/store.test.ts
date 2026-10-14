import type { D1Migration } from "@cloudflare/vitest-plugin";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeOAuthTransaction, createSession, revokeAll, sha256, SESSION_IDLE_MS, SESSION_MAX_MS, touchSession,
} from "./auth";
import type { Archive, StageSummary, WorkspacePut } from "./contracts";
import { applyPrivacyChange, blockPublication, reapplyTombstones, recordPrivacyChange } from "./privacy";
import { admitAccount, EMPTY_DOCUMENT, getWorkspace, OP_RETENTION_MS, putWorkspace } from "./store";
import type { PersonalEnv, SqlDatabase } from "./types";
import worker from "./worker";

const dbs = env as unknown as PersonalEnv & {
  PERSONAL_MIGRATIONS: D1Migration[];
  PRIVACY_MIGRATIONS: D1Migration[];
  PUBLIC_MIGRATIONS: D1Migration[];
};
const NOW = Date.UTC(2026, 8, 2);
const summary: StageSummary = {
  itemId: "item-1", stage: "R", lifetimeAttempts: 12, lifetimeIncome: 80,
  preSignupIncome: 20, manualEntry: true, verified: false,
};
const archive: Archive = { archiveId: "archive-1", summary, startedAt: NOW - 1_000, completedAt: NOW };

async function migrate(db: SqlDatabase, migrations: D1Migration[]): Promise<void> {
  for (const migration of migrations) await db.batch(migration.queries.map((sql) => db.prepare(sql)));
}
async function signup(id = "u1"): Promise<void> {
  expect(await admitAccount(dbs.PERSONAL_DB,
    { issuer: "https://accounts.google.com", sub: `subject-${id}` }, id, NOW)).toEqual({ userId: id });
}
function save(opId: string, baseRevision = 0): WorkspacePut {
  return { opId, baseRevision, document: { ...EMPTY_DOCUMENT, items: ["一"] }, action: { kind: "save" } };
}
function archiveSave(opId = "archive-op", baseRevision = 0): WorkspacePut {
  return {
    opId, baseRevision, document: { ...EMPTY_DOCUMENT, lifetimeStages: [summary] },
    action: { kind: "archive", archive },
  };
}
async function count(db: SqlDatabase, table: string): Promise<number> {
  const row = await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}
async function setQuota(bytes: number): Promise<void> {
  await dbs.PERSONAL_DB.prepare("UPDATE accounts SET quota_bytes = ? WHERE user_id = 'u1'").bind(bytes).run();
}

beforeEach(async () => {
  await reset();
  await migrate(dbs.PERSONAL_DB, dbs.PERSONAL_MIGRATIONS);
  await migrate(dbs.PRIVACY_CONTROL_DB, dbs.PRIVACY_MIGRATIONS);
  await migrate(dbs.PUBLIC_AGGREGATE_DB, dbs.PUBLIC_MIGRATIONS);
});

describe("PERSONAL_DB atomic admission and workspace operations", () => {
  it("admits exactly 150 of 160 concurrent identities without orphans", async () => {
    const results = await Promise.all(Array.from({ length: 160 }, (_, i) =>
      admitAccount(dbs.PERSONAL_DB,
        { issuer: "https://accounts.google.com", sub: `subject-${i}` }, `u${i}`, NOW)));
    expect(results.filter((result) => "userId" in result)).toHaveLength(150);
    expect(results.filter((result) => "error" in result)).toHaveLength(10);
    for (const table of ["accounts", "identities", "workspaces"]) {
      expect(await count(dbs.PERSONAL_DB, table)).toBe(150);
    }
    await expect(dbs.PERSONAL_DB.prepare(
      "INSERT INTO accounts (user_id, created_at, last_active_at) VALUES ('bypass', ?, ?)",
    ).bind(NOW, NOW).run()).rejects.toThrow("beta_full");
  });

  it("concurrent first logins for one issuer/sub converge on one workspace", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      admitAccount(dbs.PERSONAL_DB,
        { issuer: "https://accounts.google.com", sub: "shared" }, `candidate-${i}`, NOW)));
    expect(new Set(results.map((result) => "userId" in result ? result.userId : "full")).size).toBe(1);
    expect(await count(dbs.PERSONAL_DB, "accounts")).toBe(1);
    expect(await count(dbs.PERSONAL_DB, "identities")).toBe(1);
    expect(await count(dbs.PERSONAL_DB, "workspaces")).toBe(1);
  });

  it("existing-identity login refreshes activity without creating or linking a new account", async () => {
    await signup();
    const identity = { issuer: "https://accounts.google.com", sub: "subject-u1" } as const;
    expect(await admitAccount(dbs.PERSONAL_DB, identity, "new-candidate", NOW + 100)).toEqual({ userId: "u1" });
    expect(await admitAccount(dbs.PERSONAL_DB, identity, "older-candidate", NOW + 50)).toEqual({ userId: "u1" });
    expect((await dbs.PERSONAL_DB.prepare("SELECT last_active_at FROM accounts")
      .first<{ last_active_at: number }>())!.last_active_at).toBe(NOW + 100);
    expect(await count(dbs.PERSONAL_DB, "accounts")).toBe(1);
  });

  it("only one racing CAS wins and only that revision/opId gets a success row", async () => {
    await signup();
    const results = await Promise.all([
      putWorkspace(dbs.PERSONAL_DB, "u1", save("a"), NOW),
      putWorkspace(dbs.PERSONAL_DB, "u1", save("b"), NOW),
    ]);
    expect(results.filter((result) => result.status === "saved")).toHaveLength(1);
    expect(results.filter((result) => result.status === "revision_conflict")).toHaveLength(1);
    expect(await count(dbs.PERSONAL_DB, "operations")).toBe(1);
    const evidence = await dbs.PERSONAL_DB.prepare(
      `SELECT o.op_id, o.revision, w.last_op_id, w.revision AS workspace_revision
       FROM operations o JOIN workspaces w USING(user_id)`,
    ).first<{ op_id: string; revision: number; last_op_id: string; workspace_revision: number }>();
    expect(evidence!.op_id).toBe(evidence!.last_op_id);
    expect(evidence!.revision).toBe(evidence!.workspace_revision);
  });

  it("retries return the original revision, normalized requests match, changed requests conflict", async () => {
    await signup();
    const request = save("same");
    expect(await putWorkspace(dbs.PERSONAL_DB, "u1", request, NOW)).toEqual({
      status: "saved", revision: 1, replayed: false,
    });
    const normalized: WorkspacePut = {
      action: request.action, document: request.document, baseRevision: 0, opId: "same",
    };
    expect(await putWorkspace(dbs.PERSONAL_DB, "u1", normalized, NOW + 1)).toEqual({
      status: "saved", revision: 1, replayed: true,
    });
    await putWorkspace(dbs.PERSONAL_DB, "u1", save("later", 1), NOW + 2);
    expect(await putWorkspace(dbs.PERSONAL_DB, "u1", request, NOW + 3)).toEqual({
      status: "saved", revision: 1, replayed: true,
    });
    expect(await putWorkspace(dbs.PERSONAL_DB, "u1", { ...request, baseRevision: 2 }, NOW + 4))
      .toEqual({ status: "op_id_conflict" });
    expect((await getWorkspace(dbs.PERSONAL_DB, "u1"))!.revision).toBe(2);
  });

  it("same-operation concurrent retries write exactly once", async () => {
    await signup();
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      putWorkspace(dbs.PERSONAL_DB, "u1", archiveSave(), NOW)));
    expect(results.every((result) => result.status === "saved" && result.revision === 1)).toBe(true);
    expect(results.filter((result) => result.status === "saved" && !result.replayed)).toHaveLength(1);
    expect(await count(dbs.PERSONAL_DB, "pending_archives")).toBe(1);
    expect(await count(dbs.PERSONAL_DB, "operations")).toBe(1);
  });

  it("a late constraint failure rolls back workspace, stage, archive and success history", async () => {
    await signup();
    await putWorkspace(dbs.PERSONAL_DB, "u1", archiveSave(), NOW);
    const before = await getWorkspace(dbs.PERSONAL_DB, "u1");
    await expect(putWorkspace(dbs.PERSONAL_DB, "u1", archiveSave("duplicate-archive", 1), NOW + 1))
      .rejects.toThrow("UNIQUE");
    expect(await getWorkspace(dbs.PERSONAL_DB, "u1")).toEqual(before);
    expect(await count(dbs.PERSONAL_DB, "operations")).toBe(1);
    expect(await count(dbs.PERSONAL_DB, "stage_summaries")).toBe(1);
    expect(await count(dbs.PERSONAL_DB, "pending_archives")).toBe(1);
  });

  it("accounts scope operation IDs and old hashes expire without enabling stale CAS", async () => {
    await signup();
    await signup("u2");
    await putWorkspace(dbs.PERSONAL_DB, "u1", save("shared-id"), NOW);
    await putWorkspace(dbs.PERSONAL_DB, "u2", save("shared-id"), NOW);
    expect(await count(dbs.PERSONAL_DB, "operations")).toBe(2);
    await putWorkspace(dbs.PERSONAL_DB, "u1", save("new", 1), NOW + OP_RETENTION_MS + 1);
    expect(await putWorkspace(dbs.PERSONAL_DB, "u1", save("shared-id"), NOW + OP_RETENTION_MS + 2))
      .toEqual({ status: "revision_conflict", revision: 2 });
  });

  it("quota counts UTF-8, rejects only new archiving and preserves all existing data", async () => {
    await signup();
    await putWorkspace(dbs.PERSONAL_DB, "u1", archiveSave(), NOW);
    const previous = await getWorkspace(dbs.PERSONAL_DB, "u1");
    const expectedBytes = [archiveSave().document, summary, archive]
      .reduce((n, value) => n + new TextEncoder().encode(JSON.stringify(value)).byteLength, 0);
    expect(previous!.quota.bytes).toBe(expectedBytes);
    await setQuota(expectedBytes);
    expect((await getWorkspace(dbs.PERSONAL_DB, "u1"))!.quota.newArchivingBlocked).toBe(true);
    const next = archiveSave("new-archive", 1);
    next.action = { kind: "archive", archive: { ...archive, archiveId: "archive-2" } };
    expect(await putWorkspace(dbs.PERSONAL_DB, "u1", next, NOW + 1))
      .toEqual({ status: "archive_quota_reached", revision: 1 });
    expect(await count(dbs.PERSONAL_DB, "pending_archives")).toBe(1);
    expect(await count(dbs.PERSONAL_DB, "operations")).toBe(1);
    // Ordinary editing remains available, including editing lifetime summaries.
    const edited = { ...summary, lifetimeAttempts: 13 };
    expect(await putWorkspace(dbs.PERSONAL_DB, "u1", {
      ...save("edit", 1), document: { ...EMPTY_DOCUMENT, items: ["一".repeat(expectedBytes)], lifetimeStages: [edited] },
    }, NOW + 2)).toMatchObject({ status: "saved", revision: 2 });
    const projected = await dbs.PERSONAL_DB.prepare(
      "SELECT summary FROM stage_summaries WHERE user_id = 'u1'",
    ).first<{ summary: string }>();
    expect(JSON.parse(projected!.summary)).toEqual(edited);
    expect((await getWorkspace(dbs.PERSONAL_DB, "u1"))!.quota.bytes).toBeGreaterThan(expectedBytes);
    await expect(dbs.PERSONAL_DB.prepare(
      "INSERT INTO pending_archives VALUES ('u1', 'bypass', '{}', ?)",
    ).bind(NOW).run()).rejects.toThrow("archive_quota_reached");
    expect(await count(dbs.PERSONAL_DB, "pending_archives")).toBe(1);
  });

  it("accepts an archive at the exact content boundary and rejects one byte below", async () => {
    await signup();
    const request = archiveSave();
    const bytes = [request.document, summary, archive].reduce(
      (n, value) => n + new TextEncoder().encode(JSON.stringify(value)).byteLength, 0);
    await setQuota(bytes - 1);
    expect(await putWorkspace(dbs.PERSONAL_DB, "u1", request, NOW))
      .toEqual({ status: "archive_quota_reached", revision: 0 });
    await setQuota(bytes);
    expect(await putWorkspace(dbs.PERSONAL_DB, "u1", request, NOW))
      .toEqual({ status: "saved", revision: 1, replayed: false });
  });
});

describe("server session and OAuth transaction primitives (no OAuth provider)", () => {
  it("stores only token hashes, enforces 30-day idle/90-day max and revokes all", async () => {
    await signup();
    const raw = await createSession(dbs.PERSONAL_DB, "u1", NOW);
    const row = await dbs.PERSONAL_DB.prepare("SELECT token_hash FROM sessions").first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await sha256(raw));
    expect(row!.token_hash).not.toBe(raw);
    expect(await touchSession(dbs.PERSONAL_DB, raw, NOW + SESSION_IDLE_MS)).toBeNull();
    const active = await createSession(dbs.PERSONAL_DB, "u1", NOW);
    for (const day of [29, 58, 87]) {
      expect(await touchSession(dbs.PERSONAL_DB, active, NOW + day * 86_400_000)).toEqual({ userId: "u1" });
    }
    expect(await touchSession(dbs.PERSONAL_DB, active, NOW + SESSION_MAX_MS)).toBeNull();
    await createSession(dbs.PERSONAL_DB, "u1", NOW + 1);
    await revokeAll(dbs.PERSONAL_DB, "u1");
    expect(await count(dbs.PERSONAL_DB, "sessions")).toBe(0);
    expect((await dbs.PERSONAL_DB.prepare("SELECT last_active_at FROM accounts")
      .first<{ last_active_at: number }>())!.last_active_at).toBe(NOW);
  });

  it("consumes OAuth state atomically once, rejecting wrong browser and expiry", async () => {
    const state = await sha256("state");
    const browser = await sha256("browser");
    await dbs.PERSONAL_DB.prepare(
      `INSERT INTO oauth_transactions
       (state_hash, browser_hash, verifier, return_path, created_at, expires_at)
       VALUES (?, ?, 'pkce-verifier', '/', ?, ?)`,
    ).bind(state, browser, NOW, NOW + 10_000).run();
    expect(await consumeOAuthTransaction(dbs.PERSONAL_DB, state, await sha256("wrong"), NOW)).toBeNull();
    expect(await consumeOAuthTransaction(dbs.PERSONAL_DB, state, browser, NOW + 10_000)).toBeNull();
    const consumed = await Promise.all(Array.from({ length: 5 }, () =>
      consumeOAuthTransaction(dbs.PERSONAL_DB, state, browser, NOW)));
    expect(consumed.filter(Boolean)).toEqual([{
      verifier: "pkce-verifier", return_path: "/", nonce: "", started_epoch: 0,
    }]);
  });
});

describe("cross-database privacy fence and restore safety", () => {
  async function seedPublishedRelease(): Promise<void> {
    // Test-only bootstrap of a previously published generation. No production unblock API.
    await dbs.PUBLIC_AGGREGATE_DB.batch([
      dbs.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET blocked = 0"),
      dbs.PUBLIC_AGGREGATE_DB.prepare(
        "INSERT INTO weekly_releases VALUES ('r1', '2026-08-31', 0, '{\"cells\":[]}', ?)",
      ).bind(NOW),
      dbs.PUBLIC_AGGREGATE_DB.prepare(
        "INSERT INTO disclosure_history VALUES ('r1', '2026-08-31', 0, 'beta-v1', ?, NULL)",
      ).bind(NOW),
      dbs.PUBLIC_AGGREGATE_DB.prepare("UPDATE current_release SET release_id = 'r1'"),
    ]);
  }
  async function change(kind: "withdrawal" | "deletion") {
    return { opId: `privacy-${kind}`, userId: "u1", kind, identityHash: await sha256("issuer-sub") };
  }

  it("blocks publication FIRST and remains blocked after a crash before privacy commit", async () => {
    await seedPublishedRelease();
    const generation = await blockPublication(dbs, NOW + 1);
    expect(generation).toBe(1);
    expect(await count(dbs.PRIVACY_CONTROL_DB, "tombstones")).toBe(0);
    expect(await count(dbs.PUBLIC_AGGREGATE_DB, "weekly_releases")).toBe(0);
    expect((await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT release_id FROM current_release")
      .first<{ release_id: string | null }>())!.release_id).toBeNull();
    expect((await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT invalidated_at FROM disclosure_history")
      .first<{ invalidated_at: number }>())!.invalidated_at).toBe(NOW + 1);
    await expect(dbs.PUBLIC_AGGREGATE_DB.prepare(
      "INSERT INTO weekly_releases VALUES ('late', '2026-08-31', 0, '{}', ?)",
    ).bind(NOW).run()).rejects.toThrow("privacy_fenced");
    expect(await blockPublication(dbs, NOW + 2)).toBe(2);
  });

  it("refuses privacy acceptance without a durable fence and rejects generation regression/deletion", async () => {
    await expect(recordPrivacyChange(dbs, await change("withdrawal"), 1, NOW))
      .rejects.toThrow("privacy_not_fenced");
    await blockPublication(dbs, NOW);
    await expect(dbs.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET generation = 0").run())
      .rejects.toThrow("fence_regression");
    await expect(dbs.PUBLIC_AGGREGATE_DB.prepare("DELETE FROM privacy_fence").run())
      .rejects.toThrow("fence_deletion");
    expect(await count(dbs.PRIVACY_CONTROL_DB, "tombstones")).toBe(0);
  });

  it("withdrawal keeps personal records and re-applies exclusion after a restored personal snapshot", async () => {
    await signup();
    await putWorkspace(dbs.PERSONAL_DB, "u1", archiveSave(), NOW);
    const personal = await getWorkspace(dbs.PERSONAL_DB, "u1");
    await dbs.PERSONAL_DB.prepare("UPDATE accounts SET public_participation = 1").run();
    await dbs.PERSONAL_DB.prepare("INSERT INTO self_percentiles VALUES ('u1', 'r1', 'R', '{}')").run();
    const generation = await blockPublication(dbs, NOW);
    await recordPrivacyChange(dbs, await change("withdrawal"), generation, NOW);
    // Simulated crash after durable tombstone, before personal application.
    expect(await count(dbs.PERSONAL_DB, "self_percentiles")).toBe(1);
    await reapplyTombstones(dbs);
    expect(await count(dbs.PERSONAL_DB, "self_percentiles")).toBe(0);
    expect(await count(dbs.PERSONAL_DB, "pending_archives")).toBe(1);
    expect((await getWorkspace(dbs.PERSONAL_DB, "u1"))!.document).toEqual(personal!.document);
    await dbs.PERSONAL_DB.prepare("UPDATE accounts SET public_participation = 1").run();
    await dbs.PERSONAL_DB.prepare("INSERT INTO self_percentiles VALUES ('u1', 'restored', 'R', '{}')").run();
    await reapplyTombstones(dbs);
    expect(await count(dbs.PERSONAL_DB, "self_percentiles")).toBe(0);
    expect((await dbs.PERSONAL_DB.prepare("SELECT public_participation FROM accounts")
      .first<{ public_participation: number }>())!.public_participation).toBe(0);
    expect(await count(dbs.PRIVACY_CONTROL_DB, "tombstones")).toBe(1);
  });

  it("deletion cascades personal rows and durable tombstone deletes a restored account again", async () => {
    await signup();
    await putWorkspace(dbs.PERSONAL_DB, "u1", archiveSave(), NOW);
    await createSession(dbs.PERSONAL_DB, "u1", NOW);
    await dbs.PERSONAL_DB.prepare("INSERT INTO self_percentiles VALUES ('u1', 'r1', 'R', '{}')").run();
    expect(await applyPrivacyChange(dbs, await change("deletion"), NOW)).toEqual({
      fenceGeneration: 1, status: "complete",
    });
    for (const table of ["accounts", "identities", "sessions", "workspaces", "operations",
      "stage_summaries", "pending_archives", "self_percentiles"]) {
      expect(await count(dbs.PERSONAL_DB, table)).toBe(0);
    }
    await signup(); // Simulates old personal snapshot restoration, not an enabled login.
    await reapplyTombstones(dbs);
    expect(await count(dbs.PERSONAL_DB, "accounts")).toBe(0);
    expect(await count(dbs.PRIVACY_CONTROL_DB, "tombstones")).toBe(1);
    expect((await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT blocked FROM privacy_fence")
      .first<{ blocked: number }>())!.blocked).toBe(1);
  });

  it("privacy retries never clear the fence and conflicting operation reuse rolls back privacy writes", async () => {
    await signup();
    const withdrawal = await change("withdrawal");
    await applyPrivacyChange(dbs, withdrawal, NOW);
    expect(await applyPrivacyChange(dbs, withdrawal, NOW + 1)).toEqual({ fenceGeneration: 2, status: "complete" });
    expect(await count(dbs.PRIVACY_CONTROL_DB, "tombstones")).toBe(1);
    await expect(applyPrivacyChange(dbs, { ...withdrawal, kind: "deletion" }, NOW + 2))
      .rejects.toThrow("op_id_conflict");
    expect(await count(dbs.PERSONAL_DB, "accounts")).toBe(1);
    expect(await count(dbs.PRIVACY_CONTROL_DB, "tombstones")).toBe(1);
    expect((await dbs.PUBLIC_AGGREGATE_DB.prepare("SELECT generation, blocked FROM privacy_fence")
      .first<{ generation: number; blocked: number }>())).toEqual({ generation: 3, blocked: 1 });
  });

  it("HTTP middleware is fail-closed, no-store, cookie-free for guests and public data fenced", async () => {
    const local = { ...dbs, SITE_ORIGIN: "https://local", GOOGLE_CLIENT_ID: "local",
      GOOGLE_CLIENT_SECRET: "local-only-test-value" };
    const privateResponse = await worker.fetch(new Request("https://local/v1/workspace"), local);
    expect(privateResponse.status).toBe(401);
    expect(privateResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(privateResponse.headers.get("Set-Cookie")).toBeNull();
    const publicResponse = await worker.fetch(new Request("https://local/v1/statistics"), local);
    expect(publicResponse.status).toBe(503);
    expect(await publicResponse.json()).toEqual({ error: "privacy_fenced" });
    expect(publicResponse.headers.get("Cache-Control")).toBe("no-store");
  });
});
