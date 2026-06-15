import { useCallback, useEffect, useRef, useState } from "react";

import { makeDemoStats } from "../lib/demoStats";
import { statsApiBase, statsRuntimeMode } from "../lib/statsRuntime";
import { statsViewFromApiStats } from "../lib/statsView";
import { StatsApiResponseSchema } from "../schemas";
import type { StatsView } from "../ui-types";
import { useStatsSubmission } from "./useStatsSubmission";

function warnStatsRefreshFailure(reason: string, detail?: unknown) {
  if (!import.meta.env.DEV) return;
  console.warn(`[stats] ${reason}`, detail);
}

export function useStats() {
  const [statsView, setStatsView] = useState<StatsView>({ type: "hidden" });
  const statsRefreshTimerRef = useRef<number | null>(null);

  const refreshGlobalStats = useCallback(async () => {
    if (statsRuntimeMode() === "demo") {
      const stats = makeDemoStats();
      setStatsView(statsViewFromApiStats(stats));
      return;
    }
    const base = statsApiBase();
    if (!base) return;
    try {
      const response = await fetch(`${base}/api/stats`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        warnStatsRefreshFailure(`stats endpoint returned ${response.status}`);
        return;
      }
      const parsed = StatsApiResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        warnStatsRefreshFailure("stats response schema validation failed", parsed.error);
        return;
      }
      setStatsView(statsViewFromApiStats(parsed.data));
    } catch (error) {
      warnStatsRefreshFailure("stats refresh failed", error);
    }
  }, []);

  const refreshGlobalStatsDelayed = useCallback(
    (delay = 500) => {
      if (statsRefreshTimerRef.current !== null) window.clearTimeout(statsRefreshTimerRef.current);
      statsRefreshTimerRef.current = window.setTimeout(() => {
        statsRefreshTimerRef.current = null;
        void refreshGlobalStats();
      }, delay);
    },
    [refreshGlobalStats],
  );

  const queueStatsEvent = useStatsSubmission(() => refreshGlobalStatsDelayed(500));

  useEffect(() => {
    void refreshGlobalStats();
    return () => {
      if (statsRefreshTimerRef.current !== null) window.clearTimeout(statsRefreshTimerRef.current);
    };
  }, [refreshGlobalStats]);

  return { statsView, queueStatsEvent };
}
