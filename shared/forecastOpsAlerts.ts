import { GAME_DAY_MS } from "./gameDay";

/**
 * Collector budget incidents are keyed per budget kind and game day, not per
 * stream: one exhausted daily limit affects every stream at once, so per-stream
 * keys produced a new Discord channel alert (and a 30-minute renewal) for each.
 * The producer (collector store) and the dispatcher share this format, the key
 * patterns, and the silent-resolve statement so the two sides cannot drift.
 */
export type BudgetIncidentKind = "metadata" | "detail";

/** `forecast-v2:<env>:budget:<kind>:<gameDay>`; the key ends with the game day. */
export const BUDGET_INCIDENT_GLOB = "forecast-v2:*:budget:*";
/** Legacy per-stream keys `forecast-v2:<env>:<stream>:budget_exhausted`. */
export const LEGACY_BUDGET_GLOB = "forecast-v2:*:*:budget_exhausted";

/**
 * Last instant the dispatcher retires legacy per-stream `budget_exhausted` rows.
 * Every row that existed when the incident format shipped is resolved by the first
 * run; after this sunset the sweep is skipped entirely instead of scanning the
 * alert table on every flush forever.
 *
 * Deploy dependency: a dispatcher build carrying this sweep must be deployed
 * before 2026-11-21 (staging is planned this week). A later deploy is still safe —
 * the rows simply stay `open` and muted by `listDueAlerts` rather than being
 * closed — but they would no longer be retired automatically.
 */
export const LEGACY_BUDGET_SUNSET_MS = Date.parse("2026-11-21T00:00:00.000Z");

/**
 * Health counters keep one-shot incidents out of "unsent": a delivered budget
 * incident never renews, and legacy keys are never delivered at all.
 */
export const BUDGET_INCIDENT_UNSENT_FILTER = `NOT (alert_key GLOB '${BUDGET_INCIDENT_GLOB}' AND last_sent_at IS NOT NULL)
   AND NOT (alert_key GLOB '${LEGACY_BUDGET_GLOB}')`;

export function budgetIncidentPrefix(environment: string) {
  return `forecast-v2:${environment}:budget:`;
}

export function budgetIncidentKey(environment: string, kind: BudgetIncidentKind, gameDay: string) {
  return `${budgetIncidentPrefix(environment)}${kind}:${gameDay}`;
}

/** The incident's game day has ended at the next 05:00 KST boundary. */
export function budgetGameDayResetAt(gameDay: string) {
  return new Date(Date.parse(`${gameDay}T05:00:00+09:00`) + GAME_DAY_MS).toISOString();
}

export function parseBudgetIncidentKey(alertKey: string) {
  const match = /^forecast-v2:[^:]+:budget:(metadata|detail):(\d{4}-\d{2}-\d{2})$/.exec(alertKey);
  if (!match?.[1] || !match[2]) return null;
  return { kind: match[1] as BudgetIncidentKind, gameDay: match[2] };
}

/**
 * An admission failure that no budget row explains (a lease loss or an unrecorded
 * limit) is not a daily-limit incident: it keeps the normal per-stream renewal
 * policy, under its own key so it is not mistaken for the retired legacy alert.
 */
export const BUDGET_UNEXPLAINED_ERROR_CODE = "budget_unexplained";

export function budgetUnexplainedAlertKey(environment: string, stream: string) {
  return `forecast-v2:${environment}:${stream}:${BUDGET_UNEXPLAINED_ERROR_CODE}`;
}

/**
 * Close budget incidents from earlier game days (keys end with the game day, so
 * the suffix compares chronologically). `recovery_sent_at` is set together with
 * `resolved_at` because this family is one-shot: a rollover closes it silently
 * instead of posting a separate "복구" message at 05:00 KST. When
 * `reservedAttemptId` is given, the close only happens inside that reservation's
 * own batch (the attempt row must exist), so a rolled-back reservation cannot
 * close anything.
 */
export function resolveBudgetIncidentsBeforeStatement<S extends { bind(...values: unknown[]): S }>(
  db: { prepare(query: string): S },
  environment: string,
  gameDay: string,
  nowMs: number,
  reservedAttemptId?: string,
): S {
  const now = new Date(nowMs).toISOString();
  const prefix = budgetIncidentPrefix(environment);
  return db
    .prepare(
      `UPDATE forecast_ops_alerts
       SET state = 'resolved', resolved_at = ?, recovery_sent_at = ?, next_send_at = ?
       WHERE state = 'open' AND substr(alert_key, 1, ?) = ? AND substr(alert_key, -10) < ?
         ${reservedAttemptId ? "AND EXISTS(SELECT 1 FROM forecast_v2_fetch_attempts WHERE attempt_id=?)" : ""}`,
    )
    .bind(
      now,
      now,
      now,
      prefix.length,
      prefix,
      gameDay,
      ...(reservedAttemptId ? [reservedAttemptId] : []),
    );
}

/** The legacy sweep: resolves open superseded keys without any Discord delivery. */
export function retireLegacyBudgetAlertsStatement<S extends { bind(...values: unknown[]): S }>(
  db: { prepare(query: string): S },
  environment: string,
  nowMs: number,
): S {
  const now = new Date(nowMs).toISOString();
  return db
    .prepare(
      `UPDATE forecast_ops_alerts
       SET state = 'resolved', resolved_at = ?, recovery_sent_at = ?, next_send_at = ?
       WHERE environment = ? AND state = 'open' AND alert_key GLOB ?`,
    )
    .bind(now, now, now, environment, LEGACY_BUDGET_GLOB);
}
