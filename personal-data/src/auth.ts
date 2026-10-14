import type { SqlDatabase } from "./types";

export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_MAX_MS = 90 * 24 * 60 * 60 * 1_000;

export interface GoogleIdentity {
  issuer: "https://accounts.google.com";
  sub: string;
}
export interface AuthenticatedAccount { userId: string }

/** Implement only after the OAuth library spike. Never authenticate via an email. */
export interface AuthAdapter {
  authenticate(request: Request): Promise<AuthenticatedAccount | null>;
  beginGoogleLogin(request: Request): Promise<Response>;
  completeGoogleLogin(request: Request): Promise<Response>;
}

/** The raw 256-bit random session token is only sent in the HttpOnly cookie. */
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createSession(
  db: SqlDatabase, userId: string, now: number,
): Promise<string> {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  await db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, idle_expires_at, max_expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(await sha256(raw), userId, now, now + SESSION_IDLE_MS, now + SESSION_MAX_MS).run();
  return raw;
}

export async function touchSession(
  db: SqlDatabase, raw: string, now: number,
): Promise<AuthenticatedAccount | null> {
  // Touching a session is not a login/save and does not reset the two-year policy.
  const row = await db.prepare(
    `UPDATE sessions SET idle_expires_at = min(max_expires_at, ?)
     WHERE token_hash = ? AND idle_expires_at > ? AND max_expires_at > ?
     RETURNING user_id`,
  ).bind(now + SESSION_IDLE_MS, await sha256(raw), now, now).first<{ user_id: string }>();
  return row ? { userId: row.user_id } : null;
}

export async function revokeAll(db: SqlDatabase, userId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

/** PKCE verifier/state remain private; transaction consumption is one atomic SQL write. */
export async function consumeOAuthTransaction(
  db: SqlDatabase, stateHash: string, browserHash: string, now: number,
): Promise<{ verifier: string; return_path: string } | null> {
  return db.prepare(
    `UPDATE oauth_transactions SET consumed_at = ?
     WHERE state_hash = ? AND browser_hash = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING verifier, return_path`,
  ).bind(now, stateHash, browserHash, now).first<{ verifier: string; return_path: string }>();
}
