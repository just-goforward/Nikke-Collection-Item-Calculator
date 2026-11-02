import { HttpError } from "./http";
import { logFailure } from "./log";
import type { PersonalEnv } from "./types";

/**
 * A durable, identifier-free PUBLIC admission barrier precedes every privacy writer.
 * No-write failures release their lease; ambiguous writes retain it for gated recovery.
 */
export async function withPrivacyIntent<T>(
  env: PersonalEnv,
  operation: (intent: PrivacyIntent) => Promise<T>,
): Promise<T> {
  const id = crypto.randomUUID();
  const entered = await env.PUBLIC_AGGREGATE_DB.prepare(
    `INSERT INTO privacy_intents (intent_id, expires_at)
     SELECT ?, ? FROM privacy_fence WHERE singleton = 1
     AND (reconciliation_gate = 0 OR ? = 1) RETURNING intent_id`,
  )
    .bind(id, Date.now() + INTENT_LEASE_MS, Number(env.PRIVACY_RECONCILE_QUIESCENT === "true"))
    .first();
  if (!entered) throw new HttpError(503, "service_unavailable");
  let writeStarted = false;
  let completed = false;
  try {
    const result = await operation({
      beforeWrite() {
        writeStarted = true;
      },
    });
    completed = true;
    return result;
  } catch (error) {
    if (!writeStarted || (error instanceof HttpError && error.status < 500)) completed = true;
    throw error;
  } finally {
    if (completed) {
      await env.PUBLIC_AGGREGATE_DB.prepare("DELETE FROM privacy_intents WHERE intent_id = ?")
        .bind(id)
        .run();
    }
  }
}

export interface PrivacyIntent {
  beforeWrite(): void;
}
const INTENT_LEASE_MS = 10 * 60_000;

interface ReconciliationSnapshot {
  intent_version: number;
  jobs: number;
}

/** Explicit operator quiescence assertion, NOT automatic expiry-based proof of quiescence. */
export async function reconcilePrivacyIntents(
  env: PersonalEnv,
  now: number,
  snapshot?: ReconciliationSnapshot,
): Promise<boolean> {
  if (env.PRIVACY_RECONCILE_QUIESCENT !== "true" || env.PUBLICATION_ENABLED === "true")
    return false;
  const gate =
    snapshot ??
    (await env.PUBLIC_AGGREGATE_DB.prepare(
      `UPDATE privacy_fence SET reconciliation_gate = 1, blocked = 1 WHERE singleton = 1
     RETURNING intent_version`,
    ).first<{ intent_version: number }>());
  if (!gate) return false;
  const privacy = await env.PRIVACY_CONTROL_DB.prepare(
    `SELECT (SELECT count(*) FROM consent_reservations) +
     (SELECT count(*) FROM privacy_operations WHERE state = 'pending') AS n`,
  ).first<{ n: number }>();
  const jobs = snapshot
    ? { n: snapshot.jobs }
    : await env.PERSONAL_DB.prepare("SELECT count(*) AS n FROM deletion_jobs").first<{
        n: number;
      }>();
  if (!privacy || !jobs || privacy.n || jobs.n) return false;
  const result = await env.PUBLIC_AGGREGATE_DB.batch([
    env.PUBLIC_AGGREGATE_DB.prepare(
      `DELETE FROM privacy_intents WHERE expires_at <= ?
       AND EXISTS (SELECT 1 FROM privacy_fence WHERE reconciliation_gate = 1 AND intent_version = ?)
       AND NOT EXISTS (SELECT 1 FROM privacy_intents WHERE expires_at > ?)`,
    ).bind(now, gate.intent_version, now),
    env.PUBLIC_AGGREGATE_DB.prepare(
      `UPDATE privacy_fence SET pending_intents = (SELECT count(*) FROM privacy_intents),
       reconciliation_gate = 0
       WHERE singleton = 1 AND reconciliation_gate = 1 AND intent_version = ?
       AND NOT EXISTS (SELECT 1 FROM privacy_intents WHERE expires_at > ?)`,
    ).bind(gate.intent_version, now),
  ]);
  return result[1]?.meta.changes === 1;
}

export interface PrivacyChange {
  opId: string;
  userId: string;
  kind: "withdrawal" | "deletion";
}

export async function blockPublication(
  env: PersonalEnv,
  now: number,
  intent?: PrivacyIntent,
): Promise<number> {
  const statements = [
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
  ];
  intent?.beforeWrite();
  const result = await env.PUBLIC_AGGREGATE_DB.batch(statements);
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

interface ReplayResult {
  complete: boolean;
  jobs: number;
}
interface ReplayUser {
  user_id: string;
  deletion: number;
  withdrawal: number;
}
interface ReplayCheckpoint {
  intent_version: number;
  cursor: string;
  page: string | null;
  complete: number;
  jobs: number;
}

/** Scheduled restore entry. A matching completed checkpoint leaves an open gate alone. */
export async function runRestoreMaintenance(env: PersonalEnv, now: number): Promise<void> {
  if (env.PRIVACY_RECONCILE_QUIESCENT !== "true" || env.PUBLICATION_ENABLED === "true") return;
  const gate = await env.PUBLIC_AGGREGATE_DB.prepare(
    "SELECT intent_version, reconciliation_gate FROM privacy_fence WHERE singleton = 1",
  ).first<{ intent_version: number; reconciliation_gate: number }>();
  if (!gate) throw new Error("missing_privacy_fence");
  const checkpoint = await env.PERSONAL_DB.prepare(
    `SELECT intent_version, cursor, page, complete,
     (SELECT count(*) FROM deletion_jobs) AS jobs FROM restore_replay WHERE singleton = 1`,
  ).first<ReplayCheckpoint>();
  if (gate.reconciliation_gate === 0) {
    if (checkpoint?.complete && checkpoint.intent_version === gate.intent_version) return;
    const closed = await env.PUBLIC_AGGREGATE_DB.prepare(
      `UPDATE privacy_fence SET blocked = 1, intent_version = intent_version + 1,
       reconciliation_gate = 1 WHERE singleton = 1 AND reconciliation_gate = 0
       AND intent_version = ? RETURNING intent_version`,
    )
      .bind(gate.intent_version)
      .first<{ intent_version: number }>();
    if (!closed) return;
    gate.intent_version = closed.intent_version;
  }
  const replay = await reapplyTombstones(env, { intentVersion: gate.intent_version, checkpoint });
  if (replay?.complete) await reconcilePrivacyIntents(env, now, { ...gate, jobs: replay.jobs });
}

/** One durable phase per invocation, reusing the entry's checkpoint read to stay within budget. */
async function reapplyTombstonePage(
  env: PersonalEnv,
  version: number,
  checkpoint: ReplayCheckpoint | null,
): Promise<ReplayResult> {
  if (!checkpoint || checkpoint.intent_version !== version) {
    await env.PERSONAL_DB.batch([
      env.PERSONAL_DB.prepare("DELETE FROM self_percentiles"),
      env.PERSONAL_DB.prepare(
        `INSERT INTO restore_replay VALUES (1, ?, '', NULL, 0)
         ON CONFLICT(singleton) DO UPDATE SET intent_version = excluded.intent_version,
         cursor = '', page = NULL, complete = 0
         WHERE restore_replay.intent_version <= excluded.intent_version`,
      ).bind(version),
    ]);
    return { complete: false, jobs: 0 };
  }
  if (checkpoint.complete) return { complete: true, jobs: checkpoint.jobs };
  if (checkpoint.page !== null) {
    const page = JSON.parse(checkpoint.page) as ReplayUser[];
    const current = `EXISTS (SELECT 1 FROM restore_replay WHERE singleton = 1
      AND intent_version = ? AND cursor = ? AND page = ?)`;
    const applied = await env.PERSONAL_DB.batch([
      env.PERSONAL_DB.prepare(
        `DELETE FROM accounts WHERE user_id IN
         (SELECT json_extract(value, '$.user_id') FROM json_each(?)
          WHERE json_extract(value, '$.deletion') = 1) AND ${current}`,
      ).bind(checkpoint.page, version, checkpoint.cursor, checkpoint.page),
      env.PERSONAL_DB.prepare(
        `UPDATE accounts SET public_participation = 0 WHERE user_id IN
         (SELECT json_extract(value, '$.user_id') FROM json_each(?)
          WHERE json_extract(value, '$.withdrawal') = 1) AND ${current}`,
      ).bind(checkpoint.page, version, checkpoint.cursor, checkpoint.page),
      env.PERSONAL_DB.prepare(
        `UPDATE restore_replay SET cursor = ?, page = NULL, complete = ?
         WHERE singleton = 1 AND intent_version = ? AND cursor = ? AND page = ?`,
      ).bind(
        page[page.length - 1]!.user_id,
        Number(page.length < 150),
        version,
        checkpoint.cursor,
        checkpoint.page,
      ),
    ]);
    // A page whose checkpoint was not advanced is replayed forever; report the stuck state.
    if (applied[2]?.meta.changes !== 1)
      logFailure("personal_data_restore_checkpoint_failed", "incomplete_write");
    return { complete: false, jobs: checkpoint.jobs };
  }
  const result = await env.PRIVACY_CONTROL_DB.batch<ReplayUser>([
    env.PRIVACY_CONTROL_DB.prepare(
      `SELECT t.user_id, max(t.kind = 'deletion') AS deletion,
       max(t.kind = 'withdrawal' AND
         (c.participation IS NOT 1 OR c.fence_generation <= t.fence_generation)) AS withdrawal
       FROM tombstones t LEFT JOIN consent_decisions c ON c.user_id = t.user_id
       WHERE t.user_id IN
         (SELECT DISTINCT user_id FROM tombstones WHERE user_id > ? ORDER BY user_id LIMIT 150)
       GROUP BY t.user_id ORDER BY t.user_id`,
    ).bind(checkpoint.cursor),
  ]);
  const page = result[0]!.results;
  await env.PERSONAL_DB.prepare(
    `UPDATE restore_replay SET page = ?, complete = ?
     WHERE singleton = 1 AND intent_version = ? AND cursor = ? AND page IS NULL AND complete = 0`,
  )
    .bind(
      page.length ? JSON.stringify(page) : null,
      Number(!page.length),
      version,
      checkpoint.cursor,
    )
    .run();
  return { complete: false, jobs: checkpoint.jobs };
}

/**
 * Restore only, never HTTP. A scheduled version resumes one bounded phase;
 * explicit in-process callers may still await the entire O(T) replay.
 */
export async function reapplyTombstones(
  env: PersonalEnv,
  replay?: { intentVersion: number; checkpoint: ReplayCheckpoint | null },
): Promise<ReplayResult | undefined> {
  if (replay) return reapplyTombstonePage(env, replay.intentVersion, replay.checkpoint);
  if (env.PUBLICATION_ENABLED !== "true")
    await env.PERSONAL_DB.prepare("DELETE FROM self_percentiles").run();
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

export interface PrivacyChangeResult {
  fenceGeneration: number;
  status: "complete" | "pending";
}

export async function applyPrivacyChange(
  env: PersonalEnv,
  change: PrivacyChange,
  now: number,
): Promise<PrivacyChangeResult> {
  return withPrivacyIntent(env, (intent) => applyPrivacyChangeCore(env, change, now, intent));
}

async function applyPrivacyChangeCore(
  env: PersonalEnv,
  change: PrivacyChange,
  now: number,
  intent: PrivacyIntent,
): Promise<PrivacyChangeResult> {
  const fenceGeneration = await blockPublication(env, now, intent);
  await recordPrivacyChange(env, change, fenceGeneration, now);
  await reapplyUserTombstones(env, change.userId);
  const completed = await env.PRIVACY_CONTROL_DB.prepare(
    "UPDATE privacy_operations SET state = 'complete' WHERE op_id = ? AND user_id = ? AND kind = ?",
  )
    .bind(change.opId, change.userId, change.kind)
    .run();
  // The operation stays 'pending' and the fence stays closed; report it instead of completion.
  if (completed.meta.changes !== 1) {
    logFailure("personal_data_privacy_completion_failed", "incomplete_write");
    return { fenceGeneration, status: "pending" };
  }
  return { fenceGeneration, status: "complete" };
}
