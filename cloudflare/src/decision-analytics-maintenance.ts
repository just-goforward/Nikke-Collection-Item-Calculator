import { CLEANUP_ROWS_PER_TABLE } from "./decision-analytics-store.ts";

/** Readiness/budget attestation only. Never authorizes bypassing statistics_write Guard. */
export type AnalyticsMaintenanceEnv = {
  DECISION_ANALYTICS_MAINTENANCE_ENABLED?: string;
  DECISION_ANALYTICS_SCHEMA_VERSION?: string;
  DECISION_ANALYTICS_MAINTENANCE_ROWS_PER_TABLE?: string;
};
export function maintenanceRows(env: AnalyticsMaintenanceEnv): number | null {
  if (env.DECISION_ANALYTICS_MAINTENANCE_ENABLED !== "true" ||
      env.DECISION_ANALYTICS_SCHEMA_VERSION !== "3") return null;
  const raw = env.DECISION_ANALYTICS_MAINTENANCE_ROWS_PER_TABLE;
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return null;
  const rows = Number(raw);
  return Number.isSafeInteger(rows) && rows <= CLEANUP_ROWS_PER_TABLE ? rows : null;
}

export async function runDecisionAnalyticsMaintenance(
  env: AnalyticsMaintenanceEnv,
  now: number,
  ports: { guard(): Promise<void>; cleanup(now: number, rowsPerTable: number): Promise<void> },
): Promise<void> {
  const rows = maintenanceRows(env);
  if (rows === null) return;
  await ports.guard();
  await ports.cleanup(now, rows);
}

/** Independent jobs: legacy failure/latency must not prevent the bounded M2 attempt.
 * Each error remains reported; failure of reporting itself is not silently swallowed. */
export async function runStatisticsCleanupJobs(ports: {
  legacy(): Promise<void>;
  analytics(): Promise<void>;
  reportLegacy(error: unknown): void;
  reportAnalytics(error: unknown): void;
}): Promise<void> {
  await Promise.all([
    Promise.resolve().then(ports.legacy).catch(ports.reportLegacy),
    Promise.resolve().then(ports.analytics).catch(ports.reportAnalytics),
  ]);
}
