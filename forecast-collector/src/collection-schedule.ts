import type { CollectorEnv } from "./types";

const ROTATION_SLOT_MS = 180_000;

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
