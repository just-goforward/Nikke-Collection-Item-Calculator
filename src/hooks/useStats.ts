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
  const statsRefreshSequenceRef = useRef(0);
  const statsRefreshTimerRef = useRef<number | null>(null);

  const refreshGlobalStats = useCallback(async (fresh = false) => {
    const sequence = statsRefreshSequenceRef.current + 1;
    statsRefreshSequenceRef.current = sequence;
    if (statsRuntimeMode() === "demo") {
      const stats = makeDemoStats();
      setStatsView(statsViewFromApiStats(stats));
      return;
    }
    const base = statsApiBase();
    if (!base) return;
    try {
      const response = await fetch(`${base}/api/stats`, {
        cache: fresh ? "no-store" : "default",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        warnStatsRefreshFailure(`stats endpoint returned ${response.status}`);
        if (sequence === statsRefreshSequenceRef.current) {
          setStatsView({ type: "error", message: "통계를 불러오지 못했습니다." });
        }
        return;
      }
      const parsed = StatsApiResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        warnStatsRefreshFailure("stats response schema validation failed", parsed.error);
        if (sequence === statsRefreshSequenceRef.current) {
          setStatsView({ type: "error", message: "통계 응답 형식이 올바르지 않습니다." });
        }
        return;
      }
      if (sequence === statsRefreshSequenceRef.current) {
        setStatsView(statsViewFromApiStats(parsed.data));
      }
    } catch (error) {
      warnStatsRefreshFailure("stats refresh failed", error);
      if (sequence === statsRefreshSequenceRef.current) {
        setStatsView({ type: "error", message: "통계 서버에 연결하지 못했습니다." });
      }
    }
  }, []);

  const refreshGlobalStatsDelayed = useCallback(
    (delay = 500, fresh = false) => {
      if (statsRefreshTimerRef.current !== null) window.clearTimeout(statsRefreshTimerRef.current);
      statsRefreshTimerRef.current = window.setTimeout(() => {
        statsRefreshTimerRef.current = null;
        void refreshGlobalStats(fresh);
      }, delay);
    },
    [refreshGlobalStats],
  );

  const queueStatsEvent = useStatsSubmission(() => refreshGlobalStatsDelayed(500, true));

  useEffect(() => {
    void refreshGlobalStats();
    return () => {
      if (statsRefreshTimerRef.current !== null) window.clearTimeout(statsRefreshTimerRef.current);
    };
  }, [refreshGlobalStats]);

  return { statsView, queueStatsEvent };
}
