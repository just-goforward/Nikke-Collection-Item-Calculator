import type { StatsApiResponse } from "../schemas";
import type { Kit } from "../types";
import type { SegmentStat, StatsView } from "../ui-types";

export const EMPTY_STATS_MESSAGE = "아직 집계된 통계가 없습니다.";
const KIT_ORDER: Kit[] = ["blue", "purple", "yellow"];

export function statsViewFromApiStats(stats: StatsApiResponse): StatsView {
  const totalEvents = Math.max(
    Number(stats.summary?.events || 0),
    Number(stats.cumulative?.summary?.events || 0),
  );
  return totalEvents
    ? { type: "stats", stats: withSegmentKitUsage(stats) }
    : { type: "empty", message: EMPTY_STATS_MESSAGE };
}

function withSegmentKitUsage(stats: StatsApiResponse): StatsApiResponse {
  if (!Array.isArray(stats.segmentStats) || !Array.isArray(stats.levelKitStats)) return stats;
  return {
    ...stats,
    segmentStats: stats.segmentStats.map((segment) =>
      Array.isArray(segment.byKit) && segment.byKit.length > 0
        ? segment
        : { ...segment, byKit: segmentKitStats(segment, stats.levelKitStats) },
    ),
  };
}

function piecesFromStat(stat: { attempts?: number | undefined; pieces?: number | undefined }) {
  return Number(stat.pieces ?? Number(stat.attempts || 0) * 10);
}

function segmentKitStats(segment: SegmentStat, levelKitStats: StatsApiResponse["levelKitStats"]) {
  const [grade, startText] = String(segment.key || "").split(":");
  const start = Number(startText);
  if ((grade !== "R" && grade !== "SR") || !Number.isInteger(start)) return [];
  const end = start === 0 ? 4 : start === 5 ? 9 : start === 10 ? 14 : -1;
  if (end < start) return [];

  return KIT_ORDER.map((kit) => {
    const totals = (levelKitStats || [])
      .filter((row) => row.grade === grade && row.level >= start && row.level <= end)
      .reduce(
        (sum, row) => {
          const stats = row.kits[kit];
          const attempts = Number(stats?.attempts || 0);
          sum.attempts += Number(stats?.attempts || 0);
          sum.greatSuccesses += Number(stats?.greatSuccesses || 0);
          sum.pieces += piecesFromStat({
            attempts: stats?.attempts,
            pieces: stats?.pieces,
          });
          sum.weightedTheory += attempts * Number(stats?.theoreticalGreatSuccessRate || 0);
          return sum;
        },
        { attempts: 0, greatSuccesses: 0, pieces: 0, weightedTheory: 0 },
      );
    return {
      kit,
      attempts: totals.attempts,
      events: totals.attempts,
      greatSuccesses: totals.greatSuccesses,
      greatSuccessRate: totals.attempts > 0 ? totals.greatSuccesses / totals.attempts : 0,
      pieces: totals.pieces,
      theoreticalGreatSuccessRate:
        totals.attempts > 0 ? totals.weightedTheory / totals.attempts : 0,
    };
  });
}
