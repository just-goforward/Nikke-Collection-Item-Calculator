import type { SqlDatabase } from "./types";

export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_MAX_MS = 90 * 24 * 60 * 60 * 1_000;
export const FLOW_TTL_MS = 10 * 60 * 1_000;
export const SESSION_COOKIE = "__Host-session";
export const FLOW_COOKIE = "__Host-flow";

export interface GoogleIdentity {
  issuer: "https://accounts.google.com";
  sub: string;
}
export interface AuthenticatedAccount {
  userId: string;
}
export interface SessionAccount extends AuthenticatedAccount {
  tokenHash: string;
  authEpoch: number;
  maxExpiresAt: number;
  identity: GoogleIdentity;
}
export interface PendingFlow {
  verifier: string;
  nonce: string;
  return_path: string;
  started_epoch: number;
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function identityHash(identity: GoogleIdentity): Promise<string> {
  return sha256(JSON.stringify([identity.issuer, identity.sub]));
}

export function cookieValue(request: Request, name: string): string | null {
  const matches = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${name}=`));
  const value = matches.length === 1 ? matches[0]?.slice(name.length + 1) : null;
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function cookie(name: string, value: string, age: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(age))}`;
}

export async function createSession(db: SqlDatabase, userId: string, now: number): Promise<string> {
  const raw = randomToken();
  const inserted = await db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, idle_expires_at, max_expires_at, auth_epoch)
     SELECT ?, user_id, ?, ?, ?, auth_epoch FROM accounts WHERE user_id = ? AND blocked = 0`,
    )
    .bind(await sha256(raw), now, now + SESSION_IDLE_MS, now + SESSION_MAX_MS, userId)
    .run();
  // Never hand out a token for a session row that was not created (absent or blocked account).
  if (inserted.meta.changes !== 1) throw new Error("session_not_created");
  return raw;
}

/** Direct D1 binding reads use primary; never wrap authorization in withSession(). */
export async function readSession(
  db: SqlDatabase,
  raw: string,
  now: number,
): Promise<SessionAccount | null> {
  const tokenHash = await sha256(raw);
  const row = await db
    .prepare(
      `SELECT s.user_id, s.auth_epoch, s.max_expires_at, i.issuer, i.subject
     FROM sessions s JOIN accounts a USING (user_id) JOIN identities i USING (user_id)
     WHERE s.token_hash = ? AND s.idle_expires_at > ? AND s.max_expires_at > ?
     AND a.blocked = 0 AND s.auth_epoch = a.auth_epoch`,
    )
    .bind(tokenHash, now, now)
    .first<{
      user_id: string;
      auth_epoch: number;
      max_expires_at: number;
      issuer: GoogleIdentity["issuer"];
      subject: string;
    }>();
  return (
    row && {
      userId: row.user_id,
      authEpoch: row.auth_epoch,
      maxExpiresAt: row.max_expires_at,
      tokenHash,
      identity: { issuer: row.issuer, sub: row.subject },
    }
  );
}

export async function touchSession(
  db: SqlDatabase,
  raw: string,
  now: number,
): Promise<AuthenticatedAccount | null> {
  const row = await db
    .prepare(
      `UPDATE sessions SET idle_expires_at = min(max_expires_at, max(idle_expires_at, ?))
     WHERE token_hash = ? AND idle_expires_at > ? AND max_expires_at > ?
     AND EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = sessions.user_id
                 AND a.blocked = 0 AND a.auth_epoch = sessions.auth_epoch)
     RETURNING user_id`,
    )
    .bind(now + SESSION_IDLE_MS, await sha256(raw), now, now)
    .first<{ user_id: string }>();
  return row ? { userId: row.user_id } : null;
}

/** Atomic linearization: invalidates sessions AND all older anonymous login flows for this account. */
export async function revokeAll(db: SqlDatabase, userId: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE auth_control SET epoch = epoch + 1 WHERE singleton = 1"),
    db
      .prepare(
        `UPDATE accounts SET auth_epoch = (SELECT epoch FROM auth_control WHERE singleton = 1)
       WHERE user_id = ?`,
      )
      .bind(userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
  ]);
}

/** Consumes state, verifier, nonce and epoch together BEFORE any token exchange. */
export async function consumeOAuthTransaction(
  db: SqlDatabase,
  stateHash: string,
  browserHash: string,
  now: number,
): Promise<PendingFlow | null> {
  return db
    .prepare(
      `DELETE FROM oauth_transactions
     WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
     RETURNING verifier, nonce, return_path, started_epoch`,
    )
    .bind(stateHash, browserHash, now)
    .first<PendingFlow>();
}
