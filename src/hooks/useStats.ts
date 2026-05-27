import { useCallback, useEffect, useRef, useState } from "react";

import { statsApiBase, statsRuntimeMode } from "../lib/statsRuntime";
import { StatsApiResponseSchema } from "../schemas";
import { GREAT_SUCCESS } from "../solver";
import type { Grade, Kit } from "../types";
import type { GlobalStats, StatsView } from "../ui-types";
import { KIT_KEYS } from "./calculatorShared";
import { useStatsSubmission } from "./useStatsSubmission";

function demoNoise(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function clampRatio(value: number) {
  return Math.max(0, Math.min(1, value));
}

function demoSegmentBias(grade: Grade, level: number) {
  const segmentIndex = level < 5 ? 0 : level < 10 ? 1 : 2;
  const bias = [0.035, -0.035, 0] as const;
  return bias[segmentIndex] * (grade === "SR" ? 1.1 : 1);
}

function makeDemoStats(): GlobalStats & Record<string, unknown> {
  const levelKitStats = (["R", "SR"] as Grade[]).flatMap((grade) =>
    Array.from({ length: 15 }, (_, level) => {
      const kits = Object.fromEntries(
        KIT_KEYS.map((kit, kitIndex) => {
          const theoretical = ((GREAT_SUCCESS[grade]?.[kit]?.[level] || 0) as number) / 100;
          const seed = (grade === "R" ? 100 : 200) + level * 7 + kitIndex * 19;
          const baseAttempts = grade === "R" ? 74 : 58;
          const attempts = Math.round(
            baseAttempts + level * 4 + kitIndex * 18 + demoNoise(seed) * 46,
          );
          const actual = clampRatio(
            theoretical + demoSegmentBias(grade, level) + (demoNoise(seed + 3) - 0.5) * 0.006,
          );
          const greatSuccesses = Math.round(attempts * actual);
          return [
            kit,
            {
              attempts,
              greatSuccesses,
              greatSuccessRate: attempts ? greatSuccesses / attempts : 0,
              theoreticalGreatSuccessRate: theoretical,
            },
          ];
        }),
      ) as Record<
        Kit,
        {
          attempts: number;
          greatSuccesses: number;
          greatSuccessRate: number;
          theoreticalGreatSuccessRate: number;
        }
      >;
      return { grade, level, kits };
    }),
  );

  const byKit = KIT_KEYS.map((kit) => {
    const attempts = levelKitStats.reduce(
      (sum, row) => sum + Number(row.kits[kit].attempts || 0),
      0,
    );
    const greatSuccesses = levelKitStats.reduce(
      (sum, row) => sum + Number(row.kits[kit].greatSuccesses || 0),
      0,
    );
    const expected = levelKitStats.reduce(
      (sum, row) =>
        sum +
        Number(row.kits[kit].attempts || 0) *
          Number(row.kits[kit].theoreticalGreatSuccessRate || 0),
      0,
    );
    return {
      kit,
      events: Math.round(attempts / 3.8),
      attempts,
      greatSuccesses,
      greatSuccessRate: attempts ? greatSuccesses / attempts : 0,
      theoreticalGreatSuccessRate: attempts ? expected / attempts : 0,
    };
  });

  const segmentStats = (["R", "SR"] as Grade[]).flatMap((grade) =>
    [
      { key: `${grade}:0`, label: `${grade} 0 → 5`, min: 0, max: 4 },
      { key: `${grade}:5`, label: `${grade} 5 → 10`, min: 5, max: 9 },
      { key: `${grade}:10`, label: `${grade} 10 → 15`, min: 10, max: 14 },
    ].map((segment, segmentIndex) => {
      const rows = levelKitStats.filter(
        (row) => row.grade === grade && row.level >= segment.min && row.level <= segment.max,
      );
      const attempts = rows.reduce(
        (sum, row) =>
          sum + KIT_KEYS.reduce((kitSum, kit) => kitSum + Number(row.kits[kit].attempts || 0), 0),
        0,
      );
      const greatSuccesses = rows.reduce(
        (sum, row) =>
          sum +
          KIT_KEYS.reduce((kitSum, kit) => kitSum + Number(row.kits[kit].greatSuccesses || 0), 0),
        0,
      );
      const expected = rows.reduce(
        (sum, row) =>
          sum +
          KIT_KEYS.reduce(
            (kitSum, kit) =>
              kitSum +
              Number(row.kits[kit].attempts || 0) *
                Number(row.kits[kit].theoreticalGreatSuccessRate || 0),
            0,
          ),
        0,
      );
      const averageAttempts =
        grade === "SR" ? [7.8, 17.9, 20.8][segmentIndex] : [3.9, 6.7, 8.8][segmentIndex];
      return {
        key: segment.key,
        label: segment.label,
        events: Math.round(attempts / averageAttempts),
        attempts,
        greatSuccesses,
        greatSuccessRate: attempts ? greatSuccesses / attempts : 0,
        theoreticalGreatSuccessRate: attempts ? expected / attempts : 0,
        averageAttempts,
      };
    }),
  );

  const totalAttempts = byKit.reduce((sum, item) => sum + item.attempts, 0);
  const totalEvents = segmentStats.reduce((sum, item) => sum + item.events, 0);
  const totalGreatSuccesses = byKit.reduce((sum, item) => sum + item.greatSuccesses, 0);
  const mostUsedKit = byKit.reduce(
    (best, item) => (item.attempts > best.attempts ? item : best),
    byKit[0],
  );
  const cumulativeByKit = byKit.map((item) => ({
    ...item,
    attempts: item.attempts * 6,
    events: item.events * 6,
    greatSuccesses: item.greatSuccesses * 6,
  }));
  const cumulativeAttempts = cumulativeByKit.reduce((sum, item) => sum + item.attempts, 0);
  const cumulativeEvents = segmentStats.reduce((sum, item) => sum + item.events * 6, 0);
  const cumulativeGreatSuccesses = cumulativeByKit.reduce(
    (sum, item) => sum + item.greatSuccesses,
    0,
  );
  const cumulativeMostUsedKit = cumulativeByKit.reduce(
    (best, item) => (item.attempts > best.attempts ? item : best),
    cumulativeByKit[0],
  );

  return {
    windowDays: 30,
    today: "2026-05-07",
    summary: {
      events: totalEvents,
      attempts: totalAttempts,
      greatSuccesses: totalGreatSuccesses,
      greatSuccessRate: totalAttempts ? totalGreatSuccesses / totalAttempts : 0,
      todayEvents: 74,
      todayAttempts: 268,
      todayGreatSuccesses: 81,
      mostUsedKit: mostUsedKit.kit,
      mostUsedKitPieces: mostUsedKit.attempts * 10,
    },
    byKit,
    cumulative: {
      summary: {
        events: cumulativeEvents,
        attempts: cumulativeAttempts,
        greatSuccesses: cumulativeGreatSuccesses,
        greatSuccessRate: cumulativeAttempts ? cumulativeGreatSuccesses / cumulativeAttempts : 0,
        mostUsedKit: cumulativeMostUsedKit.kit,
        mostUsedKitPieces: cumulativeMostUsedKit.attempts * 10,
      },
      byKit: cumulativeByKit,
    },
    levelKitStats: [],
    segmentStats,
    successAttemptDistribution: [],
  };
}

export function useStats() {
  const [statsView, setStatsView] = useState<StatsView>({ type: "hidden" });
  const statsRefreshTimerRef = useRef<number | null>(null);

  const refreshGlobalStats = useCallback(async () => {
    if (statsRuntimeMode() === "demo") {
      const stats = makeDemoStats();
      const totalEvents = Number(stats.summary?.events || 0);
      setStatsView(
        totalEvents
          ? { type: "stats", stats }
          : { type: "empty", message: "아직 집계된 통계가 없습니다." },
      );
      return;
    }
    const base = statsApiBase();
    if (!base) return;
    try {
      const response = await fetch(`${base}/api/stats`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      const parsed = StatsApiResponseSchema.safeParse(await response.json());
      if (!parsed.success) return;
      const stats = parsed.data as unknown as GlobalStats;
      const totalEvents = Number(stats.summary?.events || 0);
      setStatsView(
        totalEvents
          ? { type: "stats", stats }
          : { type: "empty", message: "아직 집계된 통계가 없습니다." },
      );
    } catch {
      // Optional stats should not block the calculator.
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
