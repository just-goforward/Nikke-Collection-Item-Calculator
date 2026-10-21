import { FLOW_TTL_MS, identityHash, type SessionAccount, sha256 } from "./auth";
import type { ConsentGet, ConsentPut, PrivacyAccepted } from "./contracts";
import { exactKeys, HttpError, validId } from "./http";
import { failureCode, logFailure } from "./log";
import {
  blockPublication,
  type PrivacyIntent,
  reapplyUserTombstones,
  recordPrivacyChange,
  withPrivacyIntent,
} from "./privacy";
import type { PersonalEnv } from "./types";

export function consentBody(value: Record<string, unknown>): ConsentPut {
  exactKeys(value, ["opId", "baseDecisionVersion", "participation"]);
  const opId = value["opId"];
  const participation = value["participation"];
  const baseDecisionVersion = value["baseDecisionVersion"];
  if (
    !validId(opId) ||
    typeof participation !== "boolean" ||
    !Number.isSafeInteger(baseDecisionVersion) ||
    Number(baseDecisionVersion) < 0
  ) {
    throw new HttpError(400, "invalid_request");
  }
  return { opId, participation, baseDecisionVersion: Number(baseDecisionVersion) };
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

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** D1 rows are untyped; every field a reservation write depends on is read explicitly. */
function reservationRow(row: Record<string, unknown>): Reservation {
  return {
    user_id: String(row["user_id"]),
    op_id: String(row["op_id"]),
    request_hash: String(row["request_hash"]),
    base_revision: Number(row["base_revision"]),
    participation: Number(row["participation"]),
    write_nonce: String(row["write_nonce"]),
    created_at: Number(row["created_at"]),
    fence_generation: nullableNumber(row["fence_generation"]),
    attempt_nonce:
      nullableNumber(row["attempt_nonce"]) === null ? null : String(row["attempt_nonce"]),
    busy_until: Number(row["busy_until"]),
    maintenance_after: Number(row["maintenance_after"]),
  };
}

const CONSENT_LEASE_MS = 60_000;
const MAINTENANCE_RETRY_MS = 60_000;
const MAINTENANCE_BATCH = 1;

/** Preflight AND atomic per-account reservation precede the first PUBLIC write. */
export async function putConsent(
  env: PersonalEnv,
  account: SessionAccount,
  input: ConsentPut,
  now: number,
): Promise<ConsentGet> {
  return withPrivacyIntent(env, (intent) => putConsentCore(env, account, input, now, intent));
}

async function putConsentCore(
  env: PersonalEnv,
  account: SessionAccount,
  input: ConsentPut,
  now: number,
  intent: PrivacyIntent,
): Promise<ConsentGet> {
  const hash = await sha256(JSON.stringify([input.baseDecisionVersion, input.participation]));
  const nonce = crypto.randomUUID();
  const statements = [
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
  ];
  intent.beforeWrite();
  const result = await env.PRIVACY_CONTROL_DB.batch(statements);
  const operation = result[0]?.results[0];
  if (operation) {
    if (String(operation["request_hash"]) !== hash) throw new HttpError(409, "op_id_conflict");
    return getConsent(env, account.userId);
  }
  const reservedRow = result[2]?.results[0];
  const reserved = reservedRow ? reservationRow(reservedRow) : undefined;
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
  if (row)
    await withPrivacyIntent(env, (intent) => {
      intent.beforeWrite();
      return completeConsent(env, row, now);
    });
}

export async function queueDeletion(
  env: PersonalEnv,
  account: Pick<SessionAccount, "userId" | "identity">,
  opId: string,
  now: number,
  expectedLastActive: number | null = null,
): Promise<PrivacyAccepted | null> {
  return withPrivacyIntent(env, (intent) =>
    queueDeletionCore(env, account, opId, now, expectedLastActive, intent),
  );
}

async function queueDeletionCore(
  env: PersonalEnv,
  account: Pick<SessionAccount, "userId" | "identity">,
  opId: string,
  now: number,
  expectedLastActive: number | null,
  intent: PrivacyIntent,
): Promise<PrivacyAccepted | null> {
  const statements = [
    env.PERSONAL_DB.prepare("UPDATE auth_control SET epoch = epoch + 1 WHERE singleton = 1"),
    env.PERSONAL_DB.prepare(
      `UPDATE accounts SET blocked = 1, auth_epoch = (SELECT epoch FROM auth_control WHERE singleton = 1)
       WHERE user_id = ? AND blocked = 0 AND (? IS NULL OR last_active_at = ?)`,
    ).bind(account.userId, expectedLastActive, expectedLastActive),
    env.PERSONAL_DB.prepare(
      `INSERT INTO identity_deletion_fences
       SELECT ?, c.epoch, ? FROM auth_control c JOIN accounts a ON a.user_id = ?
       WHERE c.singleton = 1 AND a.blocked = 1 AND a.auth_epoch = c.epoch
       ON CONFLICT(identity_hash) DO UPDATE SET deleted_epoch = excluded.deleted_epoch,
       expires_at = excluded.expires_at`,
    ).bind(await identityHash(account.identity), now + FLOW_TTL_MS, account.userId),
    env.PERSONAL_DB.prepare(
      `INSERT OR IGNORE INTO deletion_jobs (user_id, op_id, created_at, fence_generation, fence_ready)
       SELECT user_id, ?, ?, 0, 0 FROM accounts WHERE user_id = ? AND blocked = 1
       AND auth_epoch = (SELECT epoch FROM auth_control WHERE singleton = 1)`,
    ).bind(opId, now, account.userId),
    env.PERSONAL_DB.prepare(
      `DELETE FROM sessions WHERE user_id = ? AND EXISTS
       (SELECT 1 FROM accounts a WHERE a.user_id = sessions.user_id AND a.blocked = 1
        AND a.auth_epoch = (SELECT epoch FROM auth_control WHERE singleton = 1))`,
    ).bind(account.userId),
  ];
  intent.beforeWrite();
  const results = await env.PERSONAL_DB.batch(statements);
  if (results[1]?.meta.changes !== 1) return null;
  return { operationId: opId, ...(await finishDeletion(env, account.userId)) };
}

/**
 * "pending" is returned only when the durable completion marker was not written. The deletion
 * job is then kept, so scheduled maintenance retries it instead of losing automatic recovery.
 */
type DeletionOutcome = { fenceGeneration: number; status: "complete" | "pending" };

async function finishDeletion(env: PersonalEnv, userId: string): Promise<DeletionOutcome> {
  const job = await env.PERSONAL_DB.prepare(
    "SELECT op_id, created_at, fence_generation, fence_ready FROM deletion_jobs WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ op_id: string; created_at: number; fence_generation: number; fence_ready: number }>();
  if (!job) throw new HttpError(503, "service_unavailable");
  if (!job.fence_ready) {
    job.fence_generation = await blockPublication(env, job.created_at);
    await env.PERSONAL_DB.prepare(
      "UPDATE deletion_jobs SET fence_generation = ?, fence_ready = 1 WHERE user_id = ?",
    )
      .bind(job.fence_generation, userId)
      .run();
  }
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
  const completed = await env.PRIVACY_CONTROL_DB.prepare(
    "UPDATE privacy_operations SET state = 'complete' WHERE user_id = ? AND op_id = ? AND kind = 'deletion'",
  )
    .bind(userId, job.op_id)
    .run();
  if (completed.meta.changes !== 1) {
    // A pending operation keeps publication blocked, so the job must survive to retry it.
    logFailure("personal_data_deletion_completion_failed", "incomplete_write");
    return { fenceGeneration: job.fence_generation, status: "pending" };
  }
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
    const outcome = await withPrivacyIntent(env, (intent) => {
      intent.beforeWrite();
      return finishDeletion(env, userId);
    });
    // An unwritten completion marker is reported as an unapplied deletion, never as success.
    return outcome.status === "complete";
  } catch (error) {
    // Reported as an unapplied deletion, never as success; the job row keeps the retry.
    logFailure("personal_data_deletion_resume_failed", failureCode(error));
    return false;
  }
}

/** Bounded, indexed oldest-ready queues; one failed job cannot stop the remaining jobs. */
export async function runPrivacyMaintenance(
  env: PersonalEnv,
  now: number,
  lane: "deletion" | "consent" = "deletion",
): Promise<void> {
  if (lane === "deletion") {
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
      } catch (error) {
        // The selection read itself failed for this job; isolate it from the remaining jobs.
        logFailure("personal_data_deletion_resume_failed", failureCode(error));
      }
      if (!completed) {
        try {
          await env.PERSONAL_DB.prepare(
            "UPDATE deletion_jobs SET retry_after = ? WHERE user_id = ?",
          )
            .bind(now + MAINTENANCE_RETRY_MS, userId)
            .run();
        } catch (error) {
          // The job keeps its ready retry_after, so the next run selects it again.
          logFailure("personal_data_deletion_backoff_failed", failureCode(error));
        }
      }
    }
    return;
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
    } catch (error) {
      // This delays only scheduled retries; a matching client retry can resume immediately.
      logFailure("personal_data_consent_maintenance_failed", failureCode(error));
      try {
        await env.PRIVACY_CONTROL_DB.prepare(
          "UPDATE consent_reservations SET maintenance_after = ? WHERE user_id = ? AND busy_until = 0",
        )
          .bind(now + MAINTENANCE_RETRY_MS, userId)
          .run();
      } catch (backoffError) {
        // The reservation keeps its maintenance_after, so the next run selects it again.
        logFailure("personal_data_consent_backoff_failed", failureCode(backoffError));
      }
    }
  }
}
