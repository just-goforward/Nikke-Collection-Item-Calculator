import type { GoogleIdentity } from "./auth";
import { queueDeletion } from "./consent";
import type { PersonalEnv } from "./types";

/** Two UTC calendar years; leap-day anniversaries fall on February 28 in a non-leap year. */
export function inactivityDeadline(lastActiveAt: number): number {
  const date = new Date(lastActiveAt);
  const year = date.getUTCFullYear() + 2;
  const month = date.getUTCMonth();
  const day = Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return Date.UTC(
    year,
    month,
    day,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
}

export async function runInactivityDeletion(env: PersonalEnv, now: number): Promise<void> {
  const date = new Date(now);
  // A one-day inclusive candidate envelope covers leap-day clipping; exact eligibility is below.
  const candidateCutoff = Date.UTC(
    date.getUTCFullYear() - 2,
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
  const result = await env.PERSONAL_DB.batch([
    env.PERSONAL_DB.prepare(
      `SELECT a.user_id, a.last_active_at, i.issuer, i.subject
       FROM accounts a JOIN identities i USING(user_id)
       WHERE a.blocked = 0 AND a.inactivity_retry_after <= ? AND a.last_active_at <= ?
       ORDER BY a.inactivity_retry_after, a.last_active_at, a.user_id LIMIT 1`,
    ).bind(now, candidateCutoff),
  ]);
  for (const raw of result[0]?.results ?? []) {
    const row = raw as {
      user_id: string;
      last_active_at: number;
      issuer: GoogleIdentity["issuer"];
      subject: string;
    };
    if (inactivityDeadline(row.last_active_at) > now) continue;
    try {
      await queueDeletion(
        env,
        {
          userId: row.user_id,
          identity: { issuer: row.issuer, sub: row.subject },
        },
        `inactivity-${crypto.randomUUID()}`,
        now,
        row.last_active_at,
      );
    } catch {
      // Before blocking there is no deletion job to back off. Keep this candidate from
      // monopolizing selection, without delaying a concurrently refreshed account.
      await env.PERSONAL_DB.prepare(
        `UPDATE accounts SET inactivity_retry_after = ?
         WHERE user_id = ? AND blocked = 0 AND last_active_at = ?`,
      )
        .bind(now + 60_000, row.user_id, row.last_active_at)
        .run();
    }
  }
}
