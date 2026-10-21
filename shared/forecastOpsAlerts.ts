import { GAME_DAY_MS } from "./gameDay";

/**
 * Collector budget incidents are keyed per budget kind and game day, not per
 * stream: one exhausted daily limit affects every stream at once, so per-stream
 * keys produced a new Discord channel alert (and a 30-minute renewal) for each.
 * The producer (collector store) and the dispatcher share this format.
 */
export type BudgetIncidentKind = "metadata" | "detail";

function budgetIncidentPrefix(environment: string) {
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
