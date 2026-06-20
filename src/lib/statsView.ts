import type { StatsApiResponse } from "../schemas";
import type { StatsView } from "../ui-types";

export const EMPTY_STATS_MESSAGE = "아직 집계된 통계가 없습니다.";

export function statsViewFromApiStats(stats: StatsApiResponse): StatsView {
  const totalEvents = Math.max(
    Number(stats.summary?.events || 0),
    Number(stats.cumulative?.summary?.events || 0),
  );
  return totalEvents ? { type: "stats", stats } : { type: "empty", message: EMPTY_STATS_MESSAGE };
}
