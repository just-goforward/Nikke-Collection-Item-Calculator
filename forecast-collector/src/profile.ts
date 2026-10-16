import type { CollectorEnv } from "./types";

export type ProfileCounts = { rowsPolled: number; noticesReserved: number; bodyBytes: number };

export function profilePhase(env: Pick<CollectorEnv, "ENVIRONMENT" | "COLLECTOR_PROFILE_PHASE">) {
  const value = env.COLLECTOR_PROFILE_PHASE;
  return env.ENVIRONMENT === "staging" &&
    (value === "poll-only" ||
      value === "ingest-only" ||
      value === "alternate" ||
      value === "board-48" ||
      value === "board-56")
    ? value
    : "off";
}

export function activeProfilePhase(env: CollectorEnv, scheduledTime: number) {
  const phase = profilePhase(env);
  return phase === "alternate"
    ? Math.floor(scheduledTime / 180_000) % 2 === 0
      ? "poll-only"
      : "ingest-only"
    : phase;
}

export const PROFILE_INGESTION_ADMISSION_SQL = `SELECT invocation_id FROM (
        SELECT invocation_id,status,finished_at FROM collector_invocations
        WHERE invocation_id NOT LIKE 'profile-board-%'
        ORDER BY scheduled_at DESC, started_at DESC, invocation_id DESC LIMIT 1
      ) latest WHERE status='completed' AND finished_at>=? AND finished_at<=?
        AND NOT EXISTS (
          SELECT 1 FROM runtime_ingestion_runs WHERE started_at>=latest.finished_at
        )`;

export async function profileIngestionAdmitted(
  db: { prepare(sql: string): { bind(...values: string[]): { first(): Promise<unknown> } } },
  nowMs: number,
) {
  // Two cron intervals; future timestamps and partial-board profiling never admit ingestion.
  return Boolean(
    await db
      .prepare(PROFILE_INGESTION_ADMISSION_SQL)
      .bind(new Date(nowMs - 360_000).toISOString(), new Date(nowMs).toISOString())
      .first(),
  );
}
