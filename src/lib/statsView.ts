import type { StatsApiResponse } from "../schemas";
import type { Kit } from "../types";
import type {
  KitStat,
  LevelKitStat,
  SegmentStat,
  StatsPanelModel,
  StatsSummary,
  StatsView,
} from "../ui-types";

export const EMPTY_STATS_MESSAGE = "아직 집계된 통계가 없습니다.";
const KIT_ORDER: Kit[] = ["blue", "purple", "yellow"];

type ApiKitStat = StatsApiResponse["byKit"][number];
type ApiSummary =
  | StatsApiResponse["summary"]
  | NonNullable<StatsApiResponse["cumulative"]>["summary"];

function numberValue(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeSummary(summary: ApiSummary | undefined): StatsSummary {
  return {
    events: numberValue(summary?.events),
    attempts: numberValue(summary?.attempts),
    greatSuccesses: numberValue(summary?.greatSuccesses),
    greatSuccessRate: numberValue(summary?.greatSuccessRate),
    todayEvents: numberValue(summary?.todayEvents),
    todayAttempts: numberValue(summary?.todayAttempts),
    todayGreatSuccesses: numberValue(summary?.todayGreatSuccesses),
    mostUsedKit: summary?.mostUsedKit ?? null,
    mostUsedKitPieces: numberValue(summary?.mostUsedKitPieces),
  };
}

function normalizeKitStat(source: Partial<ApiKitStat> | undefined, kit: Kit): KitStat {
  const attempts = numberValue(source?.attempts);
  return {
    kit,
    events: numberValue(source?.events),
    attempts,
    pieces: numberValue(source?.pieces ?? attempts * 10),
    greatSuccesses: numberValue(source?.greatSuccesses),
    greatSuccessRate: numberValue(source?.greatSuccessRate),
    theoreticalGreatSuccessRate: numberValue(source?.theoreticalGreatSuccessRate),
  };
}

function normalizeKitStats(rows: ApiKitStat[] | undefined) {
  return KIT_ORDER.map((kit) =>
    normalizeKitStat(
      rows?.find((row) => row.kit === kit),
      kit,
    ),
  );
}

function normalizeLevelKitStats(rows: StatsApiResponse["levelKitStats"]): LevelKitStat[] {
  return rows.map((row) => ({
    grade: row.grade,
    level: row.level,
    kits: {
      blue: normalizeKitStat(row.kits.blue, "blue"),
      purple: normalizeKitStat(row.kits.purple, "purple"),
      yellow: normalizeKitStat(row.kits.yellow, "yellow"),
    },
  }));
}

function segmentKitStats(key: string, levelKitStats: LevelKitStat[]) {
  const [grade, startText] = key.split(":");
  const start = Number(startText);
  if ((grade !== "R" && grade !== "SR") || !Number.isInteger(start)) return normalizeKitStats([]);
  const end = start === 0 ? 4 : start === 5 ? 9 : start === 10 ? 14 : -1;
  if (end < start) return normalizeKitStats([]);

  return KIT_ORDER.map((kit) => {
    const totals = levelKitStats
      .filter((row) => row.grade === grade && row.level >= start && row.level <= end)
      .reduce(
        (sum, row) => {
          const item = row.kits[kit];
          sum.events += item.events;
          sum.attempts += item.attempts;
          sum.pieces += item.pieces;
          sum.greatSuccesses += item.greatSuccesses;
          sum.weightedTheory += item.attempts * item.theoreticalGreatSuccessRate;
          return sum;
        },
        { events: 0, attempts: 0, pieces: 0, greatSuccesses: 0, weightedTheory: 0 },
      );
    return {
      kit,
      events: totals.events,
      attempts: totals.attempts,
      pieces: totals.pieces,
      greatSuccesses: totals.greatSuccesses,
      greatSuccessRate: totals.attempts > 0 ? totals.greatSuccesses / totals.attempts : 0,
      theoreticalGreatSuccessRate:
        totals.attempts > 0 ? totals.weightedTheory / totals.attempts : 0,
    };
  });
}

function normalizeSegments(
  rows: StatsApiResponse["segmentStats"],
  levelKitStats: LevelKitStat[],
): SegmentStat[] {
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    events: numberValue(row.events),
    attempts: numberValue(row.attempts),
    pieces: numberValue(row.pieces ?? numberValue(row.attempts) * 10),
    greatSuccesses: numberValue(row.greatSuccesses),
    greatSuccessRate: numberValue(row.greatSuccessRate),
    theoreticalGreatSuccessRate: numberValue(row.theoreticalGreatSuccessRate),
    averageAttempts: numberValue(row.averageAttempts),
    byKit:
      row.byKit && row.byKit.length > 0
        ? normalizeKitStats(row.byKit)
        : segmentKitStats(row.key, levelKitStats),
  }));
}

function statsPanelModelFromApi(stats: StatsApiResponse): StatsPanelModel {
  const levelKitStats = normalizeLevelKitStats(stats.levelKitStats);
  return {
    windowDays: stats.windowDays,
    summary: normalizeSummary(stats.summary),
    byKit: normalizeKitStats(stats.byKit),
    cumulative: {
      summary: normalizeSummary(stats.cumulative?.summary ?? stats.summary),
      byKit: normalizeKitStats(stats.cumulative?.byKit ?? stats.byKit),
    },
    levelKitStats,
    segmentStats: normalizeSegments(stats.segmentStats, levelKitStats),
  };
}

export function statsViewFromApiStats(stats: StatsApiResponse): StatsView {
  const model = statsPanelModelFromApi(stats);
  const totalEvents = Math.max(model.summary.events, model.cumulative.summary.events);
  return totalEvents
    ? { type: "stats", stats: model }
    : { type: "empty", message: EMPTY_STATS_MESSAGE };
}
