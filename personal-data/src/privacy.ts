import type { PersonalEnv, SqlStatement } from "./types";

export interface PrivacyChange {
  opId: string;
  userId: string;
  kind: "withdrawal" | "deletion";
  /** SHA-256 of the canonical (issuer, sub) pair; never an email hash. */
  identityHash: string;
}

/** First database commit MUST precede the authoritative privacy decision. */
export async function blockPublication(env: PersonalEnv, now: number): Promise<number> {
  const result = await env.PUBLIC_AGGREGATE_DB.batch([
    env.PUBLIC_AGGREGATE_DB.prepare(
      "UPDATE privacy_fence SET generation = generation + 1, blocked = 1 WHERE singleton = 1 RETURNING generation",
    ),
    env.PUBLIC_AGGREGATE_DB.prepare(
      `UPDATE current_release SET release_id = NULL,
       fence_generation = (SELECT generation FROM privacy_fence WHERE singleton = 1)`,
    ),
    env.PUBLIC_AGGREGATE_DB.prepare(
      "UPDATE disclosure_history SET invalidated_at = ? WHERE invalidated_at IS NULL",
    ).bind(now),
    env.PUBLIC_AGGREGATE_DB.prepare("DELETE FROM weekly_releases"),
  ]);
  const row = result[0]?.results[0] as { generation: number } | undefined;
  if (!row) throw new Error("missing_privacy_fence");
  return row.generation;
}

export async function recordPrivacyChange(
  env: PersonalEnv, change: PrivacyChange, fenceGeneration: number, now: number,
): Promise<void> {
  // Internal second step: callers must already have durably blocked publication.
  const fence = await env.PUBLIC_AGGREGATE_DB.prepare(
    "SELECT generation, blocked FROM privacy_fence WHERE singleton = 1",
  ).first<{ generation: number; blocked: number }>();
  if (!fence?.blocked || fence.generation < fenceGeneration || fenceGeneration < 1) {
    throw new Error("privacy_not_fenced");
  }
  await env.PRIVACY_CONTROL_DB.batch([
    env.PRIVACY_CONTROL_DB.prepare(
      `INSERT INTO privacy_operations (op_id, user_id, kind, fence_generation, state, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(user_id, op_id) DO UPDATE SET fence_generation = max(fence_generation, excluded.fence_generation)`,
    ).bind(change.opId, change.userId, change.kind, fenceGeneration, now),
    env.PRIVACY_CONTROL_DB.prepare(
      `INSERT INTO tombstones (user_id, kind, identity_hash, created_at, fence_generation)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, kind) DO UPDATE SET
       fence_generation = max(fence_generation, excluded.fence_generation)`,
    ).bind(change.userId, change.kind, change.identityHash, now, fenceGeneration),
    env.PRIVACY_CONTROL_DB.prepare(
      `INSERT INTO consent_decisions (user_id, participation, decision_version, decided_at)
       VALUES (?, 0, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET participation = 0,
       decision_version = decision_version + 1, decided_at = excluded.decided_at`,
    ).bind(change.userId, now),
  ]);
}

/** Must run before exposing a restored PERSONAL_DB; tombstones are never cleared. */
export async function reapplyTombstones(env: PersonalEnv): Promise<void> {
  let cursorUser = "";
  let cursorKind = "";
  // Historical tombstones can exceed the active-account cap; use bounded pages.
  for (;;) {
    const result = await env.PRIVACY_CONTROL_DB.batch([
      env.PRIVACY_CONTROL_DB.prepare(
        `SELECT t.user_id, t.kind FROM tombstones t
         LEFT JOIN consent_decisions c ON c.user_id = t.user_id
         WHERE (t.user_id > ? OR (t.user_id = ? AND t.kind > ?))
         AND (t.kind = 'deletion' OR c.participation IS NOT 1 OR c.fence_generation <= t.fence_generation)
         ORDER BY t.user_id, t.kind LIMIT 150`,
      ).bind(cursorUser, cursorUser, cursorKind),
    ]);
    const rows = result[0]?.results ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const userId = String(row["user_id"]);
      const statements: SqlStatement[] = row["kind"] === "deletion"
        ? [env.PERSONAL_DB.prepare("DELETE FROM accounts WHERE user_id = ?").bind(userId)]
        : [
          env.PERSONAL_DB.prepare("UPDATE accounts SET public_participation = 0 WHERE user_id = ?").bind(userId),
          env.PERSONAL_DB.prepare("DELETE FROM self_percentiles WHERE user_id = ?").bind(userId),
        ];
      await env.PERSONAL_DB.batch(statements);
      cursorUser = userId;
      cursorKind = String(row["kind"]);
    }
  }
}

export async function applyPrivacyChange(
  env: PersonalEnv, change: PrivacyChange, now: number,
): Promise<{ fenceGeneration: number; status: "complete" }> {
  const fenceGeneration = await blockPublication(env, now);
  await recordPrivacyChange(env, change, fenceGeneration, now);
  await reapplyTombstones(env);
  await env.PRIVACY_CONTROL_DB.prepare(
    "UPDATE privacy_operations SET state = 'complete' WHERE op_id = ? AND user_id = ? AND kind = ?",
  ).bind(change.opId, change.userId, change.kind).run();
  // Intentionally no unblocking: later milestone needs a reviewed publish/reconcile coordinator.
  return { fenceGeneration, status: "complete" };
}
