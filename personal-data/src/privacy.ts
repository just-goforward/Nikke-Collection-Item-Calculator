import type { PersonalEnv } from "./types";
import { HttpError } from "./http";

/**
 * A durable, identifier-free PUBLIC admission barrier precedes every privacy writer.
 * Unknown failures retain their marker. Only a quiescent, explicitly gated maintenance
 * procedure may reconcile an orphan; normal publication never expires/clears it.
 */
export async function withPrivacyIntent<T>(
  env: PersonalEnv, operation: () => Promise<T>,
): Promise<T> {
  const entered = await env.PUBLIC_AGGREGATE_DB.prepare(
    `UPDATE privacy_fence SET pending_intents = pending_intents + 1,
     intent_version = intent_version + 1 WHERE singleton = 1 RETURNING intent_version`,
  ).first();
  if (!entered) throw new HttpError(503, "service_unavailable");
  let completed = false;
  try {
    const result = await operation();
    completed = true;
    return result;
  } catch (error) {
    // Controlled rejection follows completed DB reads/batches, not an ambiguous transport error.
    if (error instanceof HttpError && error.status < 500) completed = true;
    throw error;
  } finally {
    if (completed) {
      await env.PUBLIC_AGGREGATE_DB.prepare(
        "UPDATE privacy_fence SET pending_intents = pending_intents - 1 WHERE singleton = 1 AND pending_intents > 0",
      ).run();
    }
  }
}

export interface PrivacyChange {
  opId: string;
  userId: string;
  kind: "withdrawal" | "deletion";
}

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
  env: PersonalEnv,
  change: PrivacyChange,
  fenceGeneration: number,
  now: number,
): Promise<void> {
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
      `INSERT INTO tombstones (user_id, kind, created_at, fence_generation)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, kind) DO UPDATE SET
       fence_generation = max(fence_generation, excluded.fence_generation)`,
    ).bind(change.userId, change.kind, now, fenceGeneration),
    env.PRIVACY_CONTROL_DB.prepare(
      `INSERT INTO consent_decisions (user_id, participation, decision_version, decided_at)
       VALUES (?, 0, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET participation = 0,
       decision_version = decision_version + 1, decided_at = excluded.decided_at`,
    ).bind(change.userId, now),
    env.PRIVACY_CONTROL_DB.prepare("DELETE FROM consent_reservations WHERE user_id = ?").bind(
      change.userId,
    ),
  ]);
}

/** Request paths touch only their authenticated/affected account; at most two tombstones. */
export async function reapplyUserTombstones(env: PersonalEnv, userId: string): Promise<void> {
  const rows = await env.PRIVACY_CONTROL_DB.batch([
    env.PRIVACY_CONTROL_DB.prepare(
      `SELECT t.kind FROM tombstones t LEFT JOIN consent_decisions c ON c.user_id = t.user_id
       WHERE t.user_id = ?
       AND (t.kind = 'deletion' OR c.participation IS NOT 1 OR c.fence_generation <= t.fence_generation)`,
    ).bind(userId),
  ]);
  if (rows[0]?.results.some((row) => row["kind"] === "deletion")) {
    await env.PERSONAL_DB.prepare("DELETE FROM accounts WHERE user_id = ?").bind(userId).run();
  } else if (rows[0]?.results.some((row) => row["kind"] === "withdrawal")) {
    await env.PERSONAL_DB.batch([
      env.PERSONAL_DB.prepare(
        "UPDATE accounts SET public_participation = 0 WHERE user_id = ?",
      ).bind(userId),
      env.PERSONAL_DB.prepare("DELETE FROM self_percentiles WHERE user_id = ?").bind(userId),
    ]);
  }
}

/** Restore/maintenance only. Never called automatically from an HTTP request. O(T) tombstones. */
export async function reapplyTombstones(env: PersonalEnv): Promise<void> {
  let cursor = "";
  for (;;) {
    const result = await env.PRIVACY_CONTROL_DB.batch([
      env.PRIVACY_CONTROL_DB.prepare(
        "SELECT DISTINCT user_id FROM tombstones WHERE user_id > ? ORDER BY user_id LIMIT 150",
      ).bind(cursor),
    ]);
    const rows = result[0]?.results ?? [];
    if (!rows.length) return;
    for (const row of rows) {
      cursor = String(row["user_id"]);
      await reapplyUserTombstones(env, cursor);
    }
  }
}

export async function applyPrivacyChange(
  env: PersonalEnv,
  change: PrivacyChange,
  now: number,
): Promise<{ fenceGeneration: number; status: "complete" }> {
  return withPrivacyIntent(env, () => applyPrivacyChangeCore(env, change, now));
}

async function applyPrivacyChangeCore(
  env: PersonalEnv, change: PrivacyChange, now: number,
): Promise<{ fenceGeneration: number; status: "complete" }> {
  const fenceGeneration = await blockPublication(env, now);
  await recordPrivacyChange(env, change, fenceGeneration, now);
  await reapplyUserTombstones(env, change.userId);
  await env.PRIVACY_CONTROL_DB.prepare(
    "UPDATE privacy_operations SET state = 'complete' WHERE op_id = ? AND user_id = ? AND kind = ?",
  )
    .bind(change.opId, change.userId, change.kind)
    .run();
  return { fenceGeneration, status: "complete" };
}
