/** All rule dates use fixed UTC+09:00, independent of the process timezone. */
export const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
const RESET_MS = 5 * 3_600_000;

function epoch(instant: string | number | Date): number {
  const value = typeof instant === "number" ? instant : new Date(instant).getTime();
  if (!Number.isFinite(value)) throw new RangeError("Invalid instant");
  return value;
}

export function gameDay(instant: string | number | Date): string {
  return new Date(epoch(instant) + KST_MS - RESET_MS).toISOString().slice(0, 10);
}

function dayEpoch(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError("Invalid game day");
  const value = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== day) {
    throw new RangeError("Invalid game day");
  }
  return value;
}

export function addGameDays(day: string, count: number): string {
  if (!Number.isInteger(count)) throw new RangeError("Expected whole game days");
  return new Date(dayEpoch(day) + count * DAY_MS).toISOString().slice(0, 10);
}

export function gameDayStart(day: string): string {
  return new Date(dayEpoch(day) - KST_MS + RESET_MS).toISOString();
}

export function gameDayEnd(day: string): string {
  return new Date(epoch(gameDayStart(day)) + DAY_MS - 1000).toISOString();
}

/** A 28-game-day collaboration includes its starting game day. */
export function collaborationEnd(startAt: string): string {
  return gameDayEnd(addGameDays(gameDay(startAt), 27));
}

/** Inclusive current game day through the same date next month, clamped. */
export function calendarRange(now: string | number | Date): { start: string; end: string } {
  const start = gameDay(now);
  const date = new Date(dayEpoch(start));
  const lastNextMonthDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 0),
  ).getUTCDate();
  const end = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      Math.min(date.getUTCDate(), lastNextMonthDay),
    ),
  )
    .toISOString()
    .slice(0, 10);
  return { start, end };
}

/** The notice convention treats an end written 4:59 as the inclusive last second. */
export function noticeEndSeconds(hour: number, minute: number): number {
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new RangeError("Invalid notice time");
  }
  return hour === 4 && minute === 59 ? 59 : 0;
}
