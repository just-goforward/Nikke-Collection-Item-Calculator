import { kstDateKeyFromUnixSeconds } from "./date-key";
import { GREAT_SUCCESS, type Grade, KIT_ORDER, type Kit } from "./domain";
import { isAllowedOrigin, jsonResponse } from "./http";
import { HttpError } from "./http-error";

type StatsReadEnv = {
  DB: D1Database;
  ALLOWED_ORIGINS?: string;
};

type StatsAggregateRow = {
  grade?: string | null;
  level?: number | string | null;
  kit?: string | null;
  events?: number | string | null;
  attempts?: number | string | null;
  great_successes?: number | string | null;
};

type SegmentGroup = NonNullable<ReturnType<typeof segmentForState>> & {
  rows: StatsAggregateRow[];
};

export async function handleStats(request: Request, env: StatsReadEnv) {
  if (!isAllowedOrigin(request, env)) throw new HttpError(403, "origin_not_allowed");
  if (!env.DB) throw new HttpError(500, "database_not_configured");
  const now = Math.floor(Date.now() / 1000);
  const today = kstDateKeyFromUnixSeconds(now);

  const [aggregateRowsResult, todayRow] = await Promise.all([
    env.DB.prepare(
      `SELECT grade, level, kit, SUM(events) AS events, SUM(attempts) AS attempts, SUM(great_successes) AS great_successes
       FROM event_aggregates
       GROUP BY grade, level, kit`,
    ).all<StatsAggregateRow>(),
    env.DB.prepare(
      `SELECT SUM(events) AS events, SUM(attempts) AS attempts, SUM(great_successes) AS great_successes
       FROM event_aggregates
       WHERE date_key = ?`,
    )
      .bind(today)
      .first(),
  ]);

  const rows = aggregateRowsResult.results || [];
  const summary = summarizeRows(rows);
  const cumulativeSummary = summary;
  const byKit = buildByKitStats(rows);
  const cumulativeByKit = byKit;
  const segmentStats = buildSegmentStats(rows);
  const mostUsedKit = mostUsedKitFromStats(byKit);
  const cumulativeMostUsedKit = mostUsedKitFromStats(cumulativeByKit);

  return jsonResponse(
    request,
    env,
    {
      windowDays: 0,
      today,
      summary: {
        ...summary,
        greatSuccessRate: rate(summary.greatSuccesses, summary.attempts),
        todayEvents: rowNumber(todayRow, "events"),
        todayAttempts: rowNumber(todayRow, "attempts"),
        todayGreatSuccesses: rowNumber(todayRow, "great_successes"),
        mostUsedKit: mostUsedKit ? mostUsedKit.kit : null,
        mostUsedKitPieces: mostUsedKit ? Number(mostUsedKit.attempts || 0) * 10 : 0,
      },
      byKit,
      cumulative: {
        summary: {
          ...cumulativeSummary,
          mostUsedKit: cumulativeMostUsedKit ? cumulativeMostUsedKit.kit : null,
          mostUsedKitPieces: cumulativeMostUsedKit
            ? Number(cumulativeMostUsedKit.attempts || 0) * 10
            : 0,
        },
        byKit: cumulativeByKit,
      },
      levelKitStats: [],
      segmentStats,
      successAttemptDistribution: [],
    },
    200,
    "public, max-age=60, s-maxage=60",
  );
}

function summarizeRows(rows: StatsAggregateRow[]) {
  const totals = rows.reduce(
    (total: { events: number; attempts: number; greatSuccesses: number }, row) => {
      total.events += Number(row.events || 0);
      total.attempts += Number(row.attempts || 0);
      total.greatSuccesses += Number(row.great_successes || 0);
      return total;
    },
    { events: 0, attempts: 0, greatSuccesses: 0 },
  );
  return {
    ...totals,
    greatSuccessRate: rate(totals.greatSuccesses, totals.attempts),
  };
}

function buildByKitStats(rows: StatsAggregateRow[]) {
  return KIT_ORDER.map((kit) => {
    const kitRows = rows.filter((item) => item.kit === kit);
    const totals = aggregateRows(kitRows);
    return {
      kit,
      events: totals.events,
      attempts: totals.attempts,
      pieces: totals.attempts * 10,
      greatSuccesses: totals.greatSuccesses,
      greatSuccessRate: rate(totals.greatSuccesses, totals.attempts),
      theoreticalGreatSuccessRate: rate(totals.expectedGreatSuccesses, totals.attempts),
    };
  });
}

function aggregateRows(rows: StatsAggregateRow[]) {
  return rows.reduce(
    (
      total: {
        events: number;
        attempts: number;
        greatSuccesses: number;
        expectedGreatSuccesses: number;
      },
      row,
    ) => {
      const attempts = Number(row.attempts || 0);
      total.events += Number(row.events || 0);
      total.attempts += attempts;
      total.greatSuccesses += Number(row.great_successes || 0);
      const grade = rowGrade(row);
      const kit = rowKit(row);
      if (grade && kit) {
        total.expectedGreatSuccesses +=
          attempts * greatSuccessProbability(grade, Number(row.level), kit);
      }
      return total;
    },
    { events: 0, attempts: 0, greatSuccesses: 0, expectedGreatSuccesses: 0 },
  );
}

function buildSegmentStats(rows: StatsAggregateRow[]) {
  const groups = new Map<string, SegmentGroup>();
  for (const row of rows) {
    const grade = rowGrade(row);
    if (!grade) continue;
    const segment = segmentForState(grade, Number(row.level));
    if (!segment) continue;
    const group = groups.get(segment.key) || { ...segment, rows: [] };
    group.rows.push(row);
    groups.set(segment.key, group);
  }

  return ["R:0", "R:5", "R:10", "SR:0", "SR:5", "SR:10"].map((key) => {
    const group = groups.get(key) || segmentForKey(key);
    const totals = aggregateRows(group.rows || []);
    const actualRate = rate(totals.greatSuccesses, totals.attempts);
    const byKit = buildByKitStats(group.rows || []);
    return {
      key,
      label: group.label,
      events: totals.events,
      attempts: totals.attempts,
      pieces: totals.attempts * 10,
      greatSuccesses: totals.greatSuccesses,
      greatSuccessRate: actualRate,
      theoreticalGreatSuccessRate: rate(totals.expectedGreatSuccesses, totals.attempts),
      averageAttempts: rate(totals.attempts, totals.events),
      byKit,
    };
  });
}

function mostUsedKitFromStats(stats: ReturnType<typeof buildByKitStats>) {
  return stats.reduce<(typeof stats)[number] | null>((best, item) => {
    if (!best || Number(item.attempts || 0) > Number(best.attempts || 0)) return item;
    return best;
  }, null);
}

function rowGrade(row: StatsAggregateRow): Grade | null {
  return row.grade === "R" || row.grade === "SR" ? row.grade : null;
}

function rowKit(row: StatsAggregateRow): Kit | null {
  return row.kit === "blue" || row.kit === "purple" || row.kit === "yellow" ? row.kit : null;
}

function greatSuccessProbability(grade: Grade, level: number, kit: Kit) {
  const table = GREAT_SUCCESS[grade]?.[kit];
  if (!table || level < 0 || level > 14) return 0;
  return Number(table[level] || 0) / 100;
}

function segmentForState(grade: Grade, level: number) {
  if (grade !== "R" && grade !== "SR") return null;
  if (level >= 0 && level <= 4) return { key: `${grade}:0`, label: `${grade} 0→5` };
  if (level >= 5 && level <= 9) return { key: `${grade}:5`, label: `${grade} 5→10` };
  if (level >= 10 && level <= 14) return { key: `${grade}:10`, label: `${grade} 10→15` };
  return null;
}

function segmentForKey(key: string) {
  const [grade, start] = key.split(":");
  const end = start === "0" ? "5" : start === "5" ? "10" : "15";
  return { key, label: `${grade} ${start}→${end}`, rows: [] };
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

function rowNumber(row: Record<string, unknown> | null | undefined, key: string) {
  return Number(row?.[key] || 0);
}
