import assert from "node:assert/strict";

const DAY = 86_400_000;
/** Independent UTC arithmetic; no product modules or floating-point rationals. */
export function medianCadence(dates: readonly string[]) {
  assert.ok(dates.length >= 2, "At least two confirmed starts required");
  const days = dates.map((date) => {
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    const value = Date.parse(`${date}T00:00:00Z`);
    assert.ok(Number.isFinite(value));
    assert.equal(new Date(value).toISOString().slice(0, 10), date);
    return BigInt(value / DAY);
  });
  const intervals = days.slice(1).map((day, index) => {
    const delta = day - days[index]!;
    assert.ok(delta > 0n, "Confirmed starts must be strictly increasing");
    return delta;
  });
  intervals.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(intervals.length / 2);
  const numerator =
    intervals.length % 2 ? intervals[middle]! : intervals[middle - 1]! + intervals[middle]!;
  const denominator = intervals.length % 2 ? 1n : 2n;
  return { numerator, denominator, predictionDays: Number(numerator / denominator) };
}

export function medianPrediction(
  dates: readonly string[],
  previousStart: string,
  previousEnd: string,
  asOf: string,
) {
  const cadence = medianCadence(dates);
  const start = Date.parse(previousStart);
  const end = Date.parse(previousEnd);
  const now = Date.parse(asOf);
  assert.ok([start, end, now].every(Number.isFinite) && end > start);
  const gameDay = (time: number) => Math.floor((time + 4 * 3_600_000) / DAY);
  assert.equal(
    new Date(gameDay(start) * DAY).toISOString().slice(0, 10),
    dates.at(-1),
    "Prediction anchor differs from confirmed history",
  );
  const original = start + cadence.predictionDays * DAY;
  const offsetDays = now <= original ? 0 : Math.max(1, gameDay(now) - gameDay(original) + 1);
  return {
    cadence,
    offsetDays,
    start: new Date(original + offsetDays * DAY).toISOString(),
    end: new Date(original + offsetDays * DAY + end - start).toISOString(),
  };
}
