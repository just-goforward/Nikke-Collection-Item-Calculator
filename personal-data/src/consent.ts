import { identityHash, sha256, type SessionAccount } from "./auth";
import type { ConsentGet, ConsentPut, PrivacyAccepted } from "./contracts";
import { exactKeys, HttpError, validId } from "./http";
import { blockPublication, reapplyTombstones, recordPrivacyChange } from "./privacy";
import type { PersonalEnv } from "./types";

export function consentBody(value: Record<string, unknown>): ConsentPut {
  exactKeys(value, ["opId", "baseDecisionVersion", "participation"]);
  if (!validId(value["opId"]) || typeof value["participation"] !== "boolean"
    || !Number.isSafeInteger(value["baseDecisionVersion"]) || Number(value["baseDecisionVersion"]) < 0) {
    throw new HttpError(400, "invalid_request");
  }
  return value as unknown as ConsentPut;
}

export async function getConsent(env: PersonalEnv, userId: string): Promise<ConsentGet> {
  const row = await env.PRIVACY_CONTROL_DB.prepare(
    "SELECT participation, decision_version FROM consent_decisions WHERE user_id = ?",
  ).bind(userId).first<{ participation: number; decision_version: number }>();
  return row
    ? { participation: row.participation === 1, decisionVersion: row.decision_version }
    : { participation: null, decisionVersion: 0 };
}

export async function putConsent(
  env: PersonalEnv, account: SessionAccount, input: ConsentPut, now: number,
): Promise<ConsentGet> {
  const requestHash = await sha256(JSON.stringify([
    input.baseDecisionVersion, input.participation,
  ]));
  // Fence BEFORE either opt-in or withdrawal. No M3 path unblocks publication.
  const generation = await blockPublication(env, now);
  const nonce = crypto.randomUUID();
  const results = await env.PRIVACY_CONTROL_DB.batch([
    env.PRIVACY_CONTROL_DB.prepare(
      `INSERT INTO consent_decisions
       (user_id, participation, decision_version, decided_at, fence_generation, last_write_nonce)
       SELECT ?, ?, 1, ?, ?, ? WHERE ? = 0
       AND NOT EXISTS (SELECT 1 FROM consent_decisions WHERE user_id = ?)
       AND NOT EXISTS (SELECT 1 FROM consent_operations WHERE user_id = ? AND op_id = ?)
       ON CONFLICT(user_id) DO NOTHING`,
    ).bind(account.userId, Number(input.participation), now, generation, nonce,
      input.baseDecisionVersion, account.userId, account.userId, input.opId),
    env.PRIVACY_CONTROL_DB.prepare(
      `UPDATE consent_decisions SET participation = ?, decision_version = decision_version + 1,
       decided_at = ?, fence_generation = ?, last_write_nonce = ?
       WHERE user_id = ? AND decision_version = ? AND last_write_nonce IS NOT ?
       AND NOT EXISTS (SELECT 1 FROM consent_operations WHERE user_id = ? AND op_id = ?)`,
    ).bind(Number(input.participation), now, generation, nonce, account.userId,
      input.baseDecisionVersion, nonce, account.userId, input.opId),
    env.PRIVACY_CONTROL_DB.prepare(
      `INSERT INTO consent_operations (user_id, op_id, request_hash, decision_version, fence_generation)
       SELECT user_id, ?, ?, decision_version, fence_generation FROM consent_decisions
       WHERE user_id = ? AND decision_version = ? AND last_write_nonce = ?`,
    ).bind(input.opId, requestHash, account.userId, input.baseDecisionVersion + 1, nonce),
    env.PRIVACY_CONTROL_DB.prepare(
      `INSERT INTO tombstones (user_id, kind, identity_hash, created_at, fence_generation)
       SELECT user_id, 'withdrawal', ?, ?, fence_generation FROM consent_decisions
       WHERE user_id = ? AND participation = 0 AND last_write_nonce = ?
       ON CONFLICT(user_id, kind) DO UPDATE SET created_at = excluded.created_at,
       fence_generation = max(fence_generation, excluded.fence_generation)`,
    ).bind(await identityHash(account.identity), now, account.userId, nonce),
    env.PRIVACY_CONTROL_DB.prepare(
      "SELECT request_hash, decision_version FROM consent_operations WHERE user_id = ? AND op_id = ?",
    ).bind(account.userId, input.opId),
  ]);
  const operation = results[4]?.results[0] as { request_hash: string; decision_version: number } | undefined;
  if (!operation) throw new HttpError(409, "revision_conflict");
  if (operation.request_hash !== requestHash) throw new HttpError(409, "op_id_conflict");
  await reapplyTombstones(env);
  return getConsent(env, account.userId);
}

export async function queueDeletion(
  env: PersonalEnv, account: SessionAccount, opId: string, now: number,
): Promise<PrivacyAccepted> {
  const hash = await identityHash(account.identity);
  const generation = await blockPublication(env, now);
  await env.PERSONAL_DB.batch([
    env.PERSONAL_DB.prepare("UPDATE auth_control SET epoch = epoch + 1 WHERE singleton = 1"),
    env.PERSONAL_DB.prepare(
      `UPDATE accounts SET blocked = 1, auth_epoch = (SELECT epoch FROM auth_control WHERE singleton = 1)
       WHERE user_id = ?`,
    ).bind(account.userId),
    env.PERSONAL_DB.prepare("INSERT OR IGNORE INTO blocked_identities VALUES (?, ?)").bind(hash, now),
    env.PERSONAL_DB.prepare("INSERT OR IGNORE INTO deletion_jobs VALUES (?, ?, ?, ?, ?)")
      .bind(account.userId, opId, hash, now, generation),
    env.PERSONAL_DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(account.userId),
  ]);
  const completed = await finishDeletion(env, account.userId);
  return { operationId: opId, ...completed };
}

async function finishDeletion(
  env: PersonalEnv, userId: string,
): Promise<{ fenceGeneration: number; status: "complete" }> {
  const job = await env.PERSONAL_DB.prepare(
    "SELECT op_id, identity_hash, created_at, fence_generation FROM deletion_jobs WHERE user_id = ?",
  ).bind(userId).first<{
    op_id: string; identity_hash: string; created_at: number; fence_generation: number;
  }>();
  if (!job) throw new HttpError(503, "service_unavailable");
  await recordPrivacyChange(env, {
    userId, opId: job.op_id, kind: "deletion", identityHash: job.identity_hash,
  }, job.fence_generation, job.created_at);
  await reapplyTombstones(env);
  await env.PRIVACY_CONTROL_DB.prepare(
    "UPDATE privacy_operations SET state = 'complete' WHERE user_id = ? AND op_id = ? AND kind = 'deletion'",
  ).bind(userId, job.op_id).run();
  await env.PERSONAL_DB.prepare("DELETE FROM deletion_jobs WHERE user_id = ?").bind(userId).run();
  return { fenceGeneration: job.fence_generation, status: "complete" };
}

/** Restartable local outbox: private authorization remains denied throughout a failed deletion. */
export async function resumeDeletions(env: PersonalEnv): Promise<void> {
  const result = await env.PERSONAL_DB.batch([
    env.PERSONAL_DB.prepare("SELECT user_id FROM deletion_jobs ORDER BY user_id LIMIT 150"),
  ]);
  for (const row of result[0]?.results ?? []) await finishDeletion(env, String(row["user_id"]));
}
