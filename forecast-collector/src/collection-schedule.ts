import type { CollectorEnv } from "./types";

const ROTATION_SLOT_MS = 180_000;
// Twelve minutes between polls, plus one minute for scheduling/collection delay.
export const ROTATION_ADMISSION_MS = 780_000;

export function collectionSchedule(env: Pick<CollectorEnv, "COLLECTION_SCHEDULE">) {
  return env.COLLECTION_SCHEDULE === "rotation" ? "rotation" : "combined";
}

export function rotationBoard(scheduledTime: number): 11 | 48 | 56 | null {
  const slot = Math.floor(scheduledTime / ROTATION_SLOT_MS) % 4;
  return slot === 0 ? 48 : slot === 1 ? 56 : slot === 2 ? 11 : null;
}

export function rotationInvocationId(board: 11 | 48 | 56, scheduledTime: number) {
  return `rotation-board-${board}:${scheduledTime}:v2`;
}

// Select the latest attempt BEFORE filtering its status: an unfinished or failed
// newer attempt must invalidate an earlier success. Used inside the lease INSERT,
// not as a separate check followed by an unconditional claim.
export const ROTATION_INGESTION_ADMISSION_SQL = `SELECT 1 FROM (
    SELECT status,finished_at FROM collector_invocations
    WHERE invocation_id LIKE 'rotation-board-48:%'
    ORDER BY scheduled_at DESC,started_at DESC,invocation_id DESC LIMIT 1
  ) board48 CROSS JOIN (
    SELECT status,finished_at FROM collector_invocations
    WHERE invocation_id LIKE 'rotation-board-56:%'
    ORDER BY scheduled_at DESC,started_at DESC,invocation_id DESC LIMIT 1
  ) board56 CROSS JOIN (
    SELECT status,finished_at FROM collector_invocations
    WHERE invocation_id LIKE 'rotation-board-11:%'
    ORDER BY scheduled_at DESC,started_at DESC,invocation_id DESC LIMIT 1
  ) board11
  WHERE board48.status='completed' AND board56.status='completed' AND board11.status='completed'
    AND MIN(board48.finished_at,board56.finished_at,board11.finished_at)>=?
    AND MAX(board48.finished_at,board56.finished_at,board11.finished_at)<=?
    AND NOT EXISTS (
      SELECT 1 FROM runtime_ingestion_runs
      WHERE token NOT LIKE 'candidate:%'
        AND started_at>=MAX(board48.finished_at,board56.finished_at,board11.finished_at)
    )`;
