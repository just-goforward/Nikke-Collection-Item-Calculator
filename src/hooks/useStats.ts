import { useCallback, useEffect, useRef, useState } from "react";

import { StatsApiResponseSchema, StatsConfigSchema } from "../schemas";
import { GREAT_SUCCESS } from "../solver";
import type { Grade, Kit } from "../types";
import type { GlobalStats, StatsView } from "../ui-types";
import { KIT_KEYS } from "./calculatorShared";

function makeEventId() {
  const randomPart =
    window.crypto && typeof window.crypto.getRandomValues === "function"
      ? Array.from(window.crypto.getRandomValues(new Uint32Array(2)))
          .map((value) => value.toString(16))
          .join("")
      : Math.random().toString(16).slice(2);
  return `${Date.now().toString(36)}-${randomPart}`;
}

function sourceHost() {
  try {
    if (!document.referrer) return "direct";
    const referrer = new URL(document.referrer);
    if (referrer.host === window.location.host) return "same-site";
    return referrer.host || "unknown";
  } catch {
    return "unknown";
  }
}

function statsConfig() {
  const parsed = StatsConfigSchema.safeParse(window.COLLECTION_STATS_CONFIG || {});
  return parsed.success ? parsed.data : {};
}

function statsApiBase() {
  const config = statsConfig();
  return typeof config.endpoint === "string" ? config.endpoint.replace(/\/+$/, "") : "";
}

function statsEnabled() {
  const config = statsConfig();
  return Boolean(statsApiBase() && config.turnstileSiteKey);
}

function statsDemoEnabled() {
  return new URLSearchParams(window.location.search).get("demoStats") === "1";
}

function demoNoise(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function clampRatio(value: number) {
  return Math.max(0, Math.min(1, value));
}

function makeDemoStats(): GlobalStats & Record<string, unknown> {
  const levelKitStats = (["R", "SR"] as Grade[]).flatMap((grade) =>
    Array.from({ length: 14 }, (_, levelIndex) => {
      const level = levelIndex + 1;
      const kits = Object.fromEntries(
        KIT_KEYS.map((kit, kitIndex) => {
          const theoretical = ((GREAT_SUCCESS[grade]?.[kit]?.[level] || 0) as number) / 100;
          const seed = (grade === "R" ? 100 : 200) + level * 7 + kitIndex * 19;
          const baseAttempts = grade === "R" ? 74 : 58;
          const attempts = Math.round(
            baseAttempts + level * 4 + kitIndex * 18 + demoNoise(seed) * 46,
          );
          const actual = clampRatio(theoretical * (0.86 + demoNoise(seed + 3) * 0.28));
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
      { key: `${grade}:1`, label: `${grade} 1 → 5`, min: 1, max: 4 },
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
    levelKitStats,
    segmentStats,
    successAttemptDistribution: [],
  };
}

export function useStats() {
  const [statsView, setStatsView] = useState<StatsView>({ type: "hidden" });
  const statsRefreshTimerRef = useRef<number | null>(null);
  const turnstileReadyPromiseRef = useRef<Promise<void> | null>(null);
  const turnstileWidgetIdRef = useRef<string | null>(null);
  const turnstileResolverRef = useRef<((token: string) => void) | null>(null);
  const turnstileRejecterRef = useRef<((error: Error) => void) | null>(null);
  const turnstileTimeoutRef = useRef<number | null>(null);

  const loadTurnstile = useCallback(async () => {
    if (window.turnstile) return;
    if (!turnstileReadyPromiseRef.current) {
      turnstileReadyPromiseRef.current = new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>(
          'script[src*="challenges.cloudflare.com/turnstile"]',
        );
        if (existing) {
          existing.addEventListener("load", () => resolve(), { once: true });
          existing.addEventListener("error", () => reject(new Error("Turnstile script failed.")), {
            once: true,
          });
          return;
        }
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.addEventListener("load", () => resolve(), { once: true });
        script.addEventListener("error", () => reject(new Error("Turnstile script failed.")), {
          once: true,
        });
        document.head.append(script);
      });
    }
    await turnstileReadyPromiseRef.current;
  }, []);

  const getTurnstileToken = useCallback(
    async (action: string) => {
      const config = statsConfig();
      await loadTurnstile();
      const turnstile = window.turnstile;
      if (!turnstile || !config.turnstileSiteKey) throw new Error("Turnstile is unavailable.");
      let container = document.getElementById("turnstileContainer");
      if (!container) {
        container = document.createElement("div");
        container.id = "turnstileContainer";
        container.hidden = true;
        document.body.append(container);
      }
      return new Promise<string>((resolve, reject) => {
        const clearPending = () => {
          if (turnstileTimeoutRef.current) window.clearTimeout(turnstileTimeoutRef.current);
          turnstileTimeoutRef.current = null;
          turnstileResolverRef.current = null;
          turnstileRejecterRef.current = null;
        };
        turnstileResolverRef.current = (token) => {
          clearPending();
          resolve(token);
        };
        turnstileRejecterRef.current = (error) => {
          clearPending();
          reject(error);
        };
        if (turnstileWidgetIdRef.current === null) {
          turnstileWidgetIdRef.current = turnstile.render(container, {
            sitekey: config.turnstileSiteKey,
            size: "invisible",
            action,
            callback: (token: string) => turnstileResolverRef.current?.(token),
            "error-callback": () =>
              turnstileRejecterRef.current?.(new Error("Turnstile challenge failed.")),
            "expired-callback": () =>
              turnstileRejecterRef.current?.(new Error("Turnstile token expired.")),
          });
        }
        turnstile.execute(turnstileWidgetIdRef.current, { action });
        turnstileTimeoutRef.current = window.setTimeout(() => {
          turnstileRejecterRef.current?.(new Error("Turnstile timed out."));
        }, 12000);
      });
    },
    [loadTurnstile],
  );

  const refreshGlobalStats = useCallback(async () => {
    if (statsDemoEnabled()) {
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

  const submitStatsEvent = useCallback(
    async (event: Record<string, unknown>) => {
      if (!statsEnabled()) return;
      const turnstileToken = await getTurnstileToken("kit_result");
      const response = await fetch(`${statsApiBase()}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          eventId: makeEventId(),
          clientTime: new Date().toISOString(),
          sourceHost: sourceHost(),
          turnstileToken,
          event,
        }),
        keepalive: true,
      });
      if (!response.ok) {
        let message = response.statusText || "Statistics request failed.";
        try {
          const body = await response.json();
          if (body?.error) message = body.error;
        } catch {
          // Optional diagnostics only.
        }
        throw new Error(message);
      }
      refreshGlobalStatsDelayed(500);
    },
    [getTurnstileToken, refreshGlobalStatsDelayed],
  );

  const queueStatsEvent = useCallback(
    (event: Record<string, unknown>) => {
      if (!statsEnabled()) return;
      submitStatsEvent(event).catch((error) => {
        console.warn("Statistics event was not submitted.", error);
      });
    },
    [submitStatsEvent],
  );

  useEffect(() => {
    void refreshGlobalStats();
    return () => {
      if (statsRefreshTimerRef.current !== null) window.clearTimeout(statsRefreshTimerRef.current);
    };
  }, [refreshGlobalStats]);

  return { statsView, queueStatsEvent };
}
