import { FLOW_TTL_MS, identityHash, type SessionAccount, sha256 } from "./auth";
import type { ConsentGet, ConsentPut, PrivacyAccepted } from "./contracts";
import { exactKeys, HttpError, validId } from "./http";
import { blockPublication, reapplyUserTombstones, recordPrivacyChange } from "./privacy";
import type { PersonalEnv } from "./types";

export function consentBody(value: Record<string, unknown>): ConsentPut {
  exactKeys(value, ["opId", "baseDecisionVersion", "participation"]);
  if (
    !validId(value["opId"]) ||
    typeof value["participation"] !== "boolean" ||
    !Number.isSafeInteger(value["baseDecisionVersion"]) ||
    Number(value["baseDecisionVersion"]) < 0
  ) {
    throw new HttpError(400, "invalid_request");
  }
  return value as unknown as ConsentPut;
}

export async function getConsent(env: PersonalEnv, userId: string): Promise<ConsentGet> {
  const row = await env.PRIVACY_CONTROL_DB.prepare(
    "SELECT participation, decision_version FROM consent_decisions WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ participation: number; decision_version: number }>();
  return row
    ? { participation: row.participation === 1, decisionVersion: row.decision_version }
    : { participation: null, decisionVersion: 0 };
}

interface Reservation {
  user_id: string;
  op_id: string;
  request_hash: string;
  base_revision: number;
  participation: number;
  write_nonce: string;
  created_at: number;
  fence_generation: number | null;
  attempt_nonce: string | null;
  busy_until: number;
  maintenance_after: number;
}

const CONSENT_LEASE_MS = 60_000;
const MAINTENANCE_RETRY_MS = 60_000;
const MAINTENANCE_BATCH = 5;

/** Preflight AND atomic per-account reservation precede the first PUBLIC write. */
export async function putConsent(
  env: PersonalEnv,
  account: SessionAccount,
  input: ConsentPut,
  now: number,
): Promise<ConsentGet> {
  const hash = await sha256(JSON.stringify([input.baseDecisionVersion, input.participation]));
  const nonce = crypto.randomUUID();
  const result = await env.PRIVACY_CONTROL_DB.batch([
    env.PRIVACY_CONTROL_DB.prepare(
      "SELECT request_hash FROM consent_operations WHERE user_id = ? AND op_id = ?",
    ).bind(account.userId, input.opId),
    env.PRIVACY_CONTROL_DB.prepare(
      `INSERT INTO consent_reservations
       (user_id, op_id, request_hash, base_revision, participation, write_nonce, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE COALESCE((SELECT decision_version FROM consent_decisions WHERE user_id = ?), 0) = ?
       AND NOT EXISTS (SELECT 1 FROM consent_operations WHERE user_id = ? AND op_id = ?)
       ON CONFLICT(user_id) DO NOTHING`,
    ).bind(
      account.userId,
      input.opId,
      hash,
      input.baseDecisionVersion,
      Number(input.participation),
      nonce,
      now,
      account.userId,
      input.baseDecisionVersion,
      account.userId,
      input.opId,
    ),
    env.PRIVACY_CONTROL_DB.prepare("SELECT * FROM consent_reservations WHERE user_id = ?").bind(
      account.userId,
    ),
  ]);
  const operation = result[0]?.results[0] as { request_hash: string } | undefined;
  if (operation) {
    if (operation.request_hash !== hash) throw new HttpError(409, "op_id_conflict");
    return getConsent(env, account.userId);
  }
  const reserved = result[2]?.results[0] as unknown as Reservation | undefined;
  if (!reserved) throw new HttpError(409, "revision_conflict");
  if (reserved.op_id !== input.opId) throw new HttpError(409, "consent_change_pending");
  if (reserved.request_hash !== hash) throw new HttpError(409, "op_id_conflict");
  return completeConsent(env, reserved, now);
}

async function completeConsent(
  env: PersonalEnv,
  reservation: Reservation,
  now: number,
): Promise<ConsentGet> {
  const attempt = crypto.randomUUID();
  const claimed = await env.PRIVACY_CONTROL_DB.prepare(
    `UPDATE consent_reservations SET attempt_nonce = ?, busy_until = ?
     WHERE user_id = ? AND write_nonce = ? AND busy_until <= ? RETURNING *`,
  )
    .bind(attempt, now + CONSENT_LEASE_MS, reservation.user_id, reservation.write_nonce, now)
    .first<Reservation>();
  if (!claimed) throw new HttpError(409, "consent_change_pending");
  const { user_id: userId, write_nonce: nonce, base_revision: base } = claimed;
  const owner =
    "SELECT 1 FROM consent_reservations WHERE user_id = ? AND write_nonce = ? AND attempt_nonce = ?";
  const ownerArgs = [userId, nonce, attempt];
  try {
    let generation = claimed.fence_generation;
    if (generation === null) {
      generation = await blockPublication(env, now);
      const saved = await env.PRIVACY_CONTROL_DB.prepare(
        "UPDATE consent_reservations SET fence_generation = ? WHERE user_id = ? AND write_nonce = ? AND attempt_nonce = ?",
      )
        .bind(generation, ...ownerArgs)
        .run();
      if (saved.meta.changes !== 1) throw new HttpError(409, "consent_change_pending");
    }
    const fence = await env.PUBLIC_AGGREGATE_DB.prepare(
      "SELECT generation, blocked FROM privacy_fence WHERE singleton = 1",
    ).first<{ generation: number; blocked: number }>();
    if (!fence?.blocked || fence.generation < generation)
      throw new HttpError(503, "service_unavailable");
    const results = await env.PRIVACY_CONTROL_DB.batch([
      env.PRIVACY_CONTROL_DB.prepare(
        `INSERT INTO consent_decisions
       (user_id, participation, decision_version, decided_at, fence_generation, last_write_nonce)
       SELECT ?, ?, 1, ?, ?, ? WHERE ? = 0
       AND EXISTS (${owner})
       ON CONFLICT(user_id) DO NOTHING`,
      ).bind(userId, claimed.participation, now, generation, nonce, base, ...ownerArgs),
      env.PRIVACY_CONTROL_DB.prepare(
        `UPDATE consent_decisions SET participation = ?, decision_version = decision_version + 1,
       decided_at = ?, fence_generation = ?, last_write_nonce = ?
       WHERE user_id = ? AND decision_version = ? AND last_write_nonce IS NOT ?
       AND EXISTS (${owner})`,
      ).bind(claimed.participation, now, generation, nonce, userId, base, nonce, ...ownerArgs),
      env.PRIVACY_CONTROL_DB.prepare(
        `INSERT INTO consent_operations (user_id, op_id, request_hash, decision_version, fence_generation)
       SELECT user_id, ?, ?, decision_version, fence_generation FROM consent_decisions
       WHERE user_id = ? AND decision_version = ? AND last_write_nonce = ?
       AND EXISTS (${owner})
       ON CONFLICT(user_id, op_id) DO NOTHING`,
      ).bind(claimed.op_id, claimed.request_hash, userId, base + 1, nonce, ...ownerArgs),
      env.PRIVACY_CONTROL_DB.prepare(
        `INSERT INTO tombstones (user_id, kind, created_at, fence_generation)
       SELECT user_id, 'withdrawal', ?, fence_generation FROM consent_decisions
       WHERE user_id = ? AND participation = 0 AND last_write_nonce = ?
       AND EXISTS (${owner})
       ON CONFLICT(user_id, kind) DO UPDATE SET created_at = excluded.created_at,
       fence_generation = max(fence_generation, excluded.fence_generation)`,
      ).bind(now, userId, nonce, ...ownerArgs),
      env.PRIVACY_CONTROL_DB.prepare(
        "SELECT request_hash FROM consent_operations WHERE user_id = ? AND op_id = ?",
      ).bind(userId, claimed.op_id),
      env.PRIVACY_CONTROL_DB.prepare(
        "DELETE FROM consent_reservations WHERE user_id = ? AND write_nonce = ? AND attempt_nonce = ?",
      ).bind(...ownerArgs),
    ]);
    if (!results[4]?.results[0]) throw new HttpError(409, "revision_conflict");
    await reapplyUserTombstones(env, userId);
    return getConsent(env, userId);
  } catch (error) {
    // An observed failure releases this attempt immediately; process death expires its lease.
    await env.PRIVACY_CONTROL_DB.prepare(
      "UPDATE consent_reservations SET attempt_nonce = NULL, busy_until = 0 WHERE user_id = ? AND write_nonce = ? AND attempt_nonce = ?",
    )
      .bind(...ownerArgs)
      .run();
    throw error;
  }
}

/** Both request retries and scheduled recovery acquire the same per-account attempt lease. */
async function recoverConsentChange(env: PersonalEnv, userId: string, now: number): Promise<void> {
  const row = await env.PRIVACY_CONTROL_DB.prepare(
    "SELECT * FROM consent_reservations WHERE user_id = ?",
  )
    .bind(userId)
    .first<Reservation>();
  if (row) await completeConsent(env, row, now);
}

export async function queueDeletion(
  env: PersonalEnv,
  account: SessionAccount,
  opId: string,
  now: number,
): Promise<PrivacyAccepted> {
  const generation = await blockPublication(env, now);
  await env.PERSONAL_DB.batch([
    env.PERSONAL_DB.prepare("UPDATE auth_control SET epoch = epoch + 1 WHERE singleton = 1"),
    env.PERSONAL_DB.prepare(
      `UPDATE accounts SET blocked = 1, auth_epoch = (SELECT epoch FROM auth_control WHERE singleton = 1)
       WHERE user_id = ?`,
    ).bind(account.userId),
    env.PERSONAL_DB.prepare(
      `INSERT INTO identity_deletion_fences
       SELECT ?, epoch, ? FROM auth_control WHERE singleton = 1
       ON CONFLICT(identity_hash) DO UPDATE SET deleted_epoch = excluded.deleted_epoch,
       expires_at = excluded.expires_at`,
    ).bind(await identityHash(account.identity), now + FLOW_TTL_MS),
    env.PERSONAL_DB.prepare(
      "INSERT OR IGNORE INTO deletion_jobs (user_id, op_id, created_at, fence_generation) VALUES (?, ?, ?, ?)",
    ).bind(account.userId, opId, now, generation),
    env.PERSONAL_DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(account.userId),
  ]);
  return { operationId: opId, ...(await finishDeletion(env, account.userId)) };
}

async function finishDeletion(
  env: PersonalEnv,
  userId: string,
): Promise<{ fenceGeneration: number; status: "complete" }> {
  const job = await env.PERSONAL_DB.prepare(
    "SELECT op_id, created_at, fence_generation FROM deletion_jobs WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ op_id: string; created_at: number; fence_generation: number }>();
  if (!job) throw new HttpError(503, "service_unavailable");
  await recordPrivacyChange(
    env,
    {
      userId,
      opId: job.op_id,
      kind: "deletion",
    },
    job.fence_generation,
    job.created_at,
  );
  await reapplyUserTombstones(env, userId);
  await env.PRIVACY_CONTROL_DB.prepare(
    "UPDATE privacy_operations SET state = 'complete' WHERE user_id = ? AND op_id = ? AND kind = 'deletion'",
  )
    .bind(userId, job.op_id)
    .run();
  await env.PERSONAL_DB.prepare("DELETE FROM deletion_jobs WHERE user_id = ?").bind(userId).run();
  return { fenceGeneration: job.fence_generation, status: "complete" };
}

/** At most one specified job. Failure is isolated; callers unrelated to it never invoke this. */
export async function resumeDeletion(env: PersonalEnv, userId: string): Promise<boolean> {
  const job = await env.PERSONAL_DB.prepare("SELECT user_id FROM deletion_jobs WHERE user_id = ?")
    .bind(userId)
    .first();
  if (!job) return true;
  try {
    await finishDeletion(env, userId);
    return true;
  } catch {
    return false;
  }
}

/** Bounded, indexed oldest-ready queues; one failed job cannot stop the remaining jobs. */
export async function runPrivacyMaintenance(env: PersonalEnv, now: number): Promise<void> {
  const deletions = await env.PERSONAL_DB.batch([
    env.PERSONAL_DB.prepare(
      `SELECT user_id FROM deletion_jobs WHERE retry_after <= ?
       ORDER BY retry_after, created_at, user_id LIMIT ?`,
    ).bind(now, MAINTENANCE_BATCH),
  ]);
  for (const row of deletions[0]?.results ?? []) {
    const userId = String(row["user_id"]);
    let completed = false;
    try {
      completed = await resumeDeletion(env, userId);
    } catch {
      completed = false;
    }
    if (!completed) {
      try {
        await env.PERSONAL_DB.prepare("UPDATE deletion_jobs SET retry_after = ? WHERE user_id = ?")
          .bind(now + MAINTENANCE_RETRY_MS, userId)
          .run();
      } catch {}
    }
  }
  const reservations = await env.PRIVACY_CONTROL_DB.batch([
    env.PRIVACY_CONTROL_DB.prepare(
      `SELECT user_id FROM consent_reservations WHERE busy_until <= ? AND maintenance_after <= ?
       ORDER BY maintenance_after, created_at, user_id LIMIT ?`,
    ).bind(now, now, MAINTENANCE_BATCH),
  ]);
  for (const row of reservations[0]?.results ?? []) {
    const userId = String(row["user_id"]);
    try {
      await recoverConsentChange(env, userId, now);
    } catch {
      // This delays only scheduled retries; a matching client retry can resume immediately.
      try {
        await env.PRIVACY_CONTROL_DB.prepare(
          "UPDATE consent_reservations SET maintenance_after = ? WHERE user_id = ? AND busy_until = 0",
        )
          .bind(now + MAINTENANCE_RETRY_MS, userId)
          .run();
      } catch {}
    }
  }
}
