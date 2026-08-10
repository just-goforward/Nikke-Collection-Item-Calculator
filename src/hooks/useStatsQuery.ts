import { useCallback, useEffect, useRef, useState } from "react";

import { message } from "../i18n/locale";
import { makeDemoStats } from "../lib/demoStats";
import { statsApiBase, statsRuntimeMode } from "../lib/statsRuntime";
import { statsViewFromApiStats } from "../lib/statsView";
import type { StatsView } from "../ui-types";

type MutableRef<T> = { current: T };

function warnStatsRefreshFailure(reason: string, detail?: unknown) {
  if (!import.meta.env.DEV) return;
  console.warn(`[stats] ${reason}`, detail);
}

function unconfiguredStatsView(): StatsView {
  return { type: "unconfigured", message: message("stats.unconfigured") };
}

function cancelStatsRefresh(
  timerRef: MutableRef<number | null>,
  sequenceRef: MutableRef<number>,
  requestRef: MutableRef<AbortController | null>,
) {
  if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  timerRef.current = null;
  sequenceRef.current += 1;
  requestRef.current?.abort();
  requestRef.current = null;
}

export function useStatsQuery(queryEnabled: boolean) {
  const [statsView, setStatsView] = useState<StatsView>({ type: "hidden" });
  const dirtyRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const activeRequestRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (fresh = false) => {
    const sequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = sequence;
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    if (statsRuntimeMode() === "demo") {
      setStatsView(statsViewFromApiStats(makeDemoStats()));
      hasLoadedRef.current = true;
      dirtyRef.current = false;
      return;
    }
    const base = statsApiBase();
    if (!base) {
      setStatsView(unconfiguredStatsView());
      dirtyRef.current = false;
      return;
    }
    const controller = new AbortController();
    activeRequestRef.current = controller;
    try {
      const response = await fetch(`${base}/api/stats`, {
        cache: fresh ? "no-store" : "default",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        warnStatsRefreshFailure(`stats endpoint returned ${response.status}`);
        if (sequence === refreshSequenceRef.current) {
          setStatsView({ type: "error", message: message("stats.loadFailed") });
        }
        return;
      }
      const { StatsApiResponseSchema } = await import("../schemas");
      const parsed = StatsApiResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        warnStatsRefreshFailure("stats response schema validation failed", parsed.error);
        if (sequence === refreshSequenceRef.current) {
          setStatsView({ type: "error", message: message("stats.invalidResponse") });
        }
        return;
      }
      if (sequence === refreshSequenceRef.current) {
        setStatsView(statsViewFromApiStats(parsed.data));
        hasLoadedRef.current = true;
        dirtyRef.current = false;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      warnStatsRefreshFailure("stats refresh failed", error);
      if (sequence === refreshSequenceRef.current) {
        setStatsView({ type: "error", message: message("stats.connectionFailed") });
      }
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
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
    if (queryEnabled) {
      refreshDelayed(500, true);
      return;
    }
    dirtyRef.current = true;
  }, [queryEnabled, refreshDelayed]);

  const retryStats = useCallback(() => {
    if (!queryEnabled) return;
    cancelStatsRefresh(refreshTimerRef, refreshSequenceRef, activeRequestRef);
    if (statsRuntimeMode() !== "demo" && !statsApiBase()) {
      setStatsView(unconfiguredStatsView());
      return;
    }
    setStatsView({ type: "loading", message: message("stats.loading") });
    void refresh(true);
  }, [queryEnabled, refresh]);

  useEffect(() => {
    if (!queryEnabled) {
      cancelStatsRefresh(refreshTimerRef, refreshSequenceRef, activeRequestRef);
      return;
    }
    if (hasLoadedRef.current && !dirtyRef.current) return;
    if (statsRuntimeMode() !== "demo" && !statsApiBase()) {
      setStatsView(unconfiguredStatsView());
      dirtyRef.current = false;
      return;
    }
    setStatsView((current) =>
      current.type === "stats" ? current : { type: "loading", message: message("stats.loading") },
    );
    void refresh();
  }, [queryEnabled, refresh]);

  useEffect(() => {
    return () => {
      cancelStatsRefresh(refreshTimerRef, refreshSequenceRef, activeRequestRef);
    };
  }, []);

  return { markSubmitted, retryStats, statsView };
}
