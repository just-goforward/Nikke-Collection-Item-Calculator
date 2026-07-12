import { useCallback, useEffect, useRef, useState } from "react";

import { makeDemoStats } from "../lib/demoStats";
import { statsApiBase, statsRuntimeMode } from "../lib/statsRuntime";
import { statsViewFromApiStats } from "../lib/statsView";
import type { StatsView } from "../ui-types";

function warnStatsRefreshFailure(reason: string, detail?: unknown) {
  if (!import.meta.env.DEV) return;
  console.warn(`[stats] ${reason}`, detail);
}

export function useStatsQuery(queryEnabled: boolean) {
  const [statsView, setStatsView] = useState<StatsView>({ type: "hidden" });
  const dirtyRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const queryEnabledRef = useRef(queryEnabled);
  queryEnabledRef.current = queryEnabled;
  const refreshSequenceRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);

  const refresh = useCallback(async (fresh = false) => {
    const sequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = sequence;
    if (statsRuntimeMode() === "demo") {
      setStatsView(statsViewFromApiStats(makeDemoStats()));
      hasLoadedRef.current = true;
      dirtyRef.current = false;
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
        if (sequence === refreshSequenceRef.current) {
          setStatsView({ type: "error", message: "통계를 불러오지 못했습니다." });
        }
        return;
      }
      const { StatsApiResponseSchema } = await import("../schemas");
      const parsed = StatsApiResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        warnStatsRefreshFailure("stats response schema validation failed", parsed.error);
        if (sequence === refreshSequenceRef.current) {
          setStatsView({ type: "error", message: "통계 응답 형식이 올바르지 않습니다." });
        }
        return;
      }
      if (sequence === refreshSequenceRef.current) {
        setStatsView(statsViewFromApiStats(parsed.data));
        hasLoadedRef.current = true;
        dirtyRef.current = false;
      }
    } catch (error) {
      warnStatsRefreshFailure("stats refresh failed", error);
      if (sequence === refreshSequenceRef.current) {
        setStatsView({ type: "error", message: "통계 서버에 연결하지 못했습니다." });
      }
    }
  }, []);

  const refreshDelayed = useCallback(
    (delay = 500, fresh = false) => {
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void refresh(fresh);
      }, delay);
    },
    [refresh],
  );

  const markSubmitted = useCallback(() => {
    if (queryEnabledRef.current) {
      refreshDelayed(500, true);
      return;
    }
    dirtyRef.current = true;
  }, [refreshDelayed]);

  useEffect(() => {
    if (!queryEnabled || (hasLoadedRef.current && !dirtyRef.current)) return;
    setStatsView((current) =>
      current.type === "hidden" ? { type: "empty", message: "통계를 불러오는 중입니다." } : current,
    );
    void refresh();
  }, [queryEnabled, refresh]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    };
  }, []);

  return { markSubmitted, statsView };
}
