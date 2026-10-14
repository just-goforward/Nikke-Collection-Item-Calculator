import { identityHash, sha256, type GoogleIdentity } from "./auth";
import type { Json, WorkspaceDocument, WorkspaceGet, WorkspacePut, WorkspacePutResult } from "./contracts";
import type { SqlDatabase, SqlStatement } from "./types";

export const EMPTY_DOCUMENT: WorkspaceDocument = { schemaVersion: 1, items: [], lifetimeStages: [] };
export const OP_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/** Object key order is not part of operation identity; array order is. */
function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}

const usedBytes = `(length(CAST(w.document AS BLOB))
  + COALESCE((SELECT sum(length(CAST(summary AS BLOB))) FROM stage_summaries WHERE user_id = w.user_id), 0)
  + COALESCE((SELECT sum(length(CAST(payload AS BLOB))) FROM pending_archives WHERE user_id = w.user_id), 0)
  + COALESCE((SELECT sum(length(CAST(payload AS BLOB))) FROM self_percentiles WHERE user_id = w.user_id), 0))`;

/** Internal post-OIDC-verification port, not an exposed signup API. */
export async function admitAccount(
  db: SqlDatabase, identity: GoogleIdentity, candidateUserId: string, now: number,
): Promise<{ userId: string } | { error: "beta_full" }> {
  const results = await db.batch(await provisioningStatements(db, identity, candidateUserId, now));
  const row = results[results.length - 1]?.results[0] as { user_id: string } | undefined;
  return row ? { userId: row.user_id } : { error: "beta_full" };
}

/** Shared by admission tests and callback's atomic provision-plus-session batch. */
export async function provisioningStatements(
  db: SqlDatabase, identity: GoogleIdentity, candidateUserId: string, now: number,
): Promise<SqlStatement[]> {
  return [
    db.prepare(
      `INSERT INTO accounts (user_id, created_at, last_active_at)
       SELECT ?, ?, ? WHERE (SELECT count(*) FROM accounts) < 150
       AND NOT EXISTS (SELECT 1 FROM blocked_identities WHERE identity_hash = ?)
       AND NOT EXISTS (SELECT 1 FROM identities WHERE issuer = ? AND subject = ?)`,
    ).bind(candidateUserId, now, now, await identityHash(identity), identity.issuer, identity.sub),
    db.prepare(
      `INSERT INTO identities (issuer, subject, user_id)
       SELECT ?, ?, user_id FROM accounts WHERE user_id = ?
       AND NOT EXISTS (SELECT 1 FROM identities WHERE issuer = ? AND subject = ?)`,
    ).bind(identity.issuer, identity.sub, candidateUserId, identity.issuer, identity.sub),
    db.prepare(
      `INSERT INTO workspaces (user_id, document)
       SELECT user_id, ? FROM accounts WHERE user_id = ?
       AND NOT EXISTS (SELECT 1 FROM workspaces WHERE user_id = ?)`,
    ).bind(JSON.stringify(EMPTY_DOCUMENT), candidateUserId, candidateUserId),
    db.prepare(
      `UPDATE accounts SET last_active_at = max(last_active_at, ?)
       WHERE user_id = (SELECT user_id FROM identities WHERE issuer = ? AND subject = ?)`,
    ).bind(now, identity.issuer, identity.sub),
    db.prepare(
      "SELECT user_id FROM identities WHERE issuer = ? AND subject = ?",
    ).bind(identity.issuer, identity.sub),
  ];
}

export interface WorkspaceRow {
  revision: number;
  last_op_id: string | null;
  document: string;
  quota_bytes: number;
  bytes: number;
}

export function workspaceRead(db: SqlDatabase, userId: string): SqlStatement {
  return db.prepare(
    `SELECT w.*, a.quota_bytes, ${usedBytes} AS bytes FROM workspaces w
     JOIN accounts a USING (user_id) WHERE w.user_id = ?`,
  ).bind(userId);
}

export function workspaceResult(row: WorkspaceRow | null): WorkspaceGet | null {
  return row && {
    revision: row.revision, lastOpId: row.last_op_id,
    document: JSON.parse(row.document) as WorkspaceDocument,
    quota: { bytes: row.bytes, limitBytes: row.quota_bytes, newArchivingBlocked: row.bytes >= row.quota_bytes },
  };
}

export async function getWorkspace(db: SqlDatabase, userId: string): Promise<WorkspaceGet | null> {
  return workspaceResult(await workspaceRead(db, userId).first<WorkspaceRow>());
}

export async function putWorkspace(
  db: SqlDatabase, userId: string, request: WorkspacePut, now: number,
): Promise<WorkspacePutResult> {
  const requestHash = await sha256(canonical(request as unknown as Json));
  const document = canonical(request.document as unknown as Json);
  const nonce = crypto.randomUUID();
  const archive = request.action.kind === "archive" ? request.action.archive : null;
  const stages = request.document.lifetimeStages;
  const stageBytes = stages.reduce((bytes, stage) =>
    bytes + new TextEncoder().encode(canonical(stage as unknown as Json)).byteLength, 0);
  if (archive && !stages.some((stage) =>
    canonical(stage as unknown as Json) === canonical(archive.summary as unknown as Json))) {
    throw new Error("archive_summary_missing_from_document");
  }
  const payload = archive ? canonical(archive as unknown as Json) : "";
  const costGuard = archive ? `AND (
    length(CAST(? AS BLOB))
    + ?
    + COALESCE((SELECT sum(length(CAST(payload AS BLOB))) FROM pending_archives WHERE user_id = w.user_id), 0)
    + length(CAST(? AS BLOB))
    + COALESCE((SELECT sum(length(CAST(payload AS BLOB))) FROM self_percentiles WHERE user_id = w.user_id), 0)
  ) <= (SELECT quota_bytes FROM accounts WHERE user_id = w.user_id)` : "";
  const update = db.prepare(
    `UPDATE workspaces AS w SET document = ?, revision = revision + 1,
     last_op_id = ?, last_write_nonce = ?
     WHERE user_id = ? AND revision = ?
     AND NOT EXISTS (SELECT 1 FROM operations WHERE user_id = w.user_id AND op_id = ?)
     ${costGuard}`,
  );
  const args: (string | number | null)[] = [
    document, request.opId, nonce, userId, request.baseRevision, request.opId,
  ];
  if (archive) args.push(document, stageBytes, payload);
  const statements: SqlStatement[] = [update.bind(...args)];
  // The nonce proves this invocation won, even when the previous winning opId is identical.
  const winner = `SELECT 1 FROM workspaces WHERE user_id = ? AND revision = ?
                  AND last_op_id = ? AND last_write_nonce = ?`;
  const winnerArgs = [userId, request.baseRevision + 1, request.opId, nonce];
  // Summaries are an editable projection of the authoritative lifetime-stage document.
  statements.push(db.prepare(
    `DELETE FROM stage_summaries WHERE user_id = ? AND EXISTS (${winner})`,
  ).bind(userId, ...winnerArgs));
  statements.push(db.prepare(
      `INSERT INTO stage_summaries (user_id, item_id, stage, summary)
       SELECT ?, json_extract(value, '$.itemId'), json_extract(value, '$.stage'), value
       FROM json_each(?) WHERE EXISTS (${winner})`,
    ).bind(userId, canonical(stages as unknown as Json), ...winnerArgs));
  if (archive) {
    statements.push(
      db.prepare(
        `INSERT INTO pending_archives (user_id, archive_id, payload, created_at)
         SELECT ?, ?, ?, ? WHERE EXISTS (${winner})`,
      ).bind(userId, archive.archiveId, payload, now, ...winnerArgs),
    );
  }
  statements.push(
    db.prepare(
      `INSERT INTO operations (user_id, op_id, request_hash, revision, action, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (${winner})`,
    ).bind(userId, request.opId, requestHash, request.baseRevision + 1, request.action.kind, now, ...winnerArgs),
    db.prepare(
      `UPDATE accounts SET last_active_at = max(last_active_at, ?) WHERE user_id = ? AND EXISTS (${winner})`,
    ).bind(now, userId, ...winnerArgs),
    db.prepare(
      `DELETE FROM operations WHERE user_id = ? AND created_at < ? AND EXISTS (${winner})`,
    ).bind(userId, now - OP_RETENTION_MS, ...winnerArgs),
    db.prepare("SELECT request_hash, revision FROM operations WHERE user_id = ? AND op_id = ?")
      .bind(userId, request.opId),
    db.prepare("SELECT revision FROM workspaces WHERE user_id = ?").bind(userId),
  );
  const results = await db.batch(statements);
  const operation = results[results.length - 2]?.results[0] as
    { request_hash: string; revision: number } | undefined;
  if (operation) {
    return operation.request_hash === requestHash
      ? { status: "saved", revision: operation.revision, replayed: results[0]?.meta.changes === 0 }
      : { status: "op_id_conflict" };
  }
  const current = results[results.length - 1]?.results[0] as { revision: number } | undefined;
  if (!current) throw new Error("account_not_found");
  return {
    status: archive && current.revision === request.baseRevision ? "archive_quota_reached" : "revision_conflict",
    revision: current.revision,
  };
}
