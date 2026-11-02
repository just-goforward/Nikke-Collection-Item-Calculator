/** Game dates use a fixed 05:00 KST reset; KST has no daylight-saving offset. */
export const GAME_DAY_MS = 86_400_000;

export function gameDayKey(timestampMs: number): string {
  return new Date(timestampMs + 4 * 3_600_000).toISOString().slice(0, 10);
}

export function gameDayStartMs(timestampMs: number): number {
  return Date.parse(`${gameDayKey(timestampMs)}T05:00:00+09:00`);
}

export function gameDayStartCeilMs(timestampMs: number): number {
  const start = gameDayStartMs(timestampMs);
  return start >= timestampMs ? start : start + GAME_DAY_MS;
}
