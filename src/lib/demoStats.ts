import type { StatsApiResponse } from "../schemas";
import { GREAT_SUCCESS } from "../solver/domain";
import type { Grade, Kit } from "../types";

const DEMO_KITS = ["blue", "purple", "yellow"] as const satisfies readonly Kit[];

const AVERAGE_ATTEMPTS_BY_GRADE = {
  R: [3.9, 6.7, 8.8],
  SR: [7.8, 17.9, 20.8],
} satisfies Record<Grade, readonly [number, number, number]>;

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

type DemoKitRate = {
  attempts: number;
  greatSuccesses: number;
  greatSuccessRate: number;
  theoreticalGreatSuccessRate: number;
};

type DemoLevelKitRow = {
  grade: Grade;
  level: number;
  kits: Record<Kit, DemoKitRate>;
};

type DemoKitSummary = {
  kit: Kit;
  events: number;
  attempts: number;
  pieces: number;
  greatSuccesses: number;
  greatSuccessRate: number;
  theoreticalGreatSuccessRate: number;
};

const DEMO_SEGMENTS = [
  { min: 0, max: 4, suffix: "0", labelRange: "0 → 5" },
  { min: 5, max: 9, suffix: "5", labelRange: "5 → 10" },
  { min: 10, max: 14, suffix: "10", labelRange: "10 → 15" },
] as const;

function makeLevelKitStats(): DemoLevelKitRow[] {
  return (["R", "SR"] as Grade[]).flatMap((grade) =>
    Array.from({ length: 15 }, (_, level) => ({
      grade,
      level,
      kits: Object.fromEntries(
        DEMO_KITS.map((kit, kitIndex) => [kit, demoKitRate(grade, level, kit, kitIndex)]),
      ) as Record<Kit, DemoKitRate>,
    })),
  );
}

function demoKitRate(grade: Grade, level: number, kit: Kit, kitIndex: number): DemoKitRate {
  const theoretical = ((GREAT_SUCCESS[grade]?.[kit]?.[level] || 0) as number) / 100;
  const seed = (grade === "R" ? 100 : 200) + level * 7 + kitIndex * 19;
  const baseAttempts = grade === "R" ? 74 : 58;
  const attempts = Math.round(baseAttempts + level * 4 + kitIndex * 18 + demoNoise(seed) * 46);
  const actual = clampRatio(
    theoretical + demoSegmentBias(grade, level) + (demoNoise(seed + 3) - 0.5) * 0.006,
  );
  const greatSuccesses = Math.round(attempts * actual);
  return {
    attempts,
    greatSuccesses,
    greatSuccessRate: attempts ? greatSuccesses / attempts : 0,
    theoreticalGreatSuccessRate: theoretical,
  };
}

function makeByKit(levelKitStats: DemoLevelKitRow[]): DemoKitSummary[] {
  return DEMO_KITS.map((kit) => {
    const { attempts, expected, greatSuccesses } = sumKitRows(levelKitStats, kit);
    return {
      kit,
      events: Math.round(attempts / 3.8),
      attempts,
      pieces: attempts * 10,
      greatSuccesses,
      greatSuccessRate: attempts ? greatSuccesses / attempts : 0,
      theoreticalGreatSuccessRate: attempts ? expected / attempts : 0,
    };
  });
}

function sumKitRows(rows: DemoLevelKitRow[], kit: Kit) {
  return rows.reduce(
    (sum, row) => {
      const rate = row.kits[kit];
      sum.attempts += Number(rate.attempts || 0);
      sum.greatSuccesses += Number(rate.greatSuccesses || 0);
      sum.expected += Number(rate.attempts || 0) * Number(rate.theoreticalGreatSuccessRate || 0);
      return sum;
    },
    { attempts: 0, expected: 0, greatSuccesses: 0 },
  );
}

function makeSegmentStats(levelKitStats: DemoLevelKitRow[]) {
  return (["R", "SR"] as Grade[]).flatMap((grade) =>
    DEMO_SEGMENTS.map((segment, segmentIndex) => {
      const rows = levelKitStats.filter(
        (row) => row.grade === grade && row.level >= segment.min && row.level <= segment.max,
      );
      const totals = sumAllKitRows(rows);
      const averageAttempts = demoAverageAttempts(grade, segmentIndex);
      const byKit = DEMO_KITS.map((kit) => {
        const { attempts, expected, greatSuccesses } = sumKitRows(rows, kit);
        return {
          kit,
          events: Math.round(attempts / averageAttempts),
          attempts,
          pieces: attempts * 10,
          greatSuccesses,
          greatSuccessRate: attempts ? greatSuccesses / attempts : 0,
          theoreticalGreatSuccessRate: attempts ? expected / attempts : 0,
        };
      });
      return {
        key: `${grade}:${segment.suffix}`,
        label: `${grade} ${segment.labelRange}`,
        events: Math.round(totals.attempts / averageAttempts),
        attempts: totals.attempts,
        pieces: totals.attempts * 10,
        greatSuccesses: totals.greatSuccesses,
        greatSuccessRate: totals.attempts ? totals.greatSuccesses / totals.attempts : 0,
        theoreticalGreatSuccessRate: totals.attempts ? totals.expected / totals.attempts : 0,
        averageAttempts,
        byKit,
      };
    }),
  );
}

function demoAverageAttempts(grade: Grade, segmentIndex: number) {
  const averageAttempts = AVERAGE_ATTEMPTS_BY_GRADE[grade][segmentIndex];
  if (averageAttempts === undefined) {
    throw new Error(`Missing demo average attempts for ${grade} segment ${segmentIndex}.`);
  }
  return averageAttempts;
}

function sumAllKitRows(rows: DemoLevelKitRow[]) {
  return rows.reduce(
    (sum, row) => {
      for (const kit of DEMO_KITS) {
        const rate = row.kits[kit];
        sum.attempts += Number(rate.attempts || 0);
        sum.greatSuccesses += Number(rate.greatSuccesses || 0);
        sum.expected += Number(rate.attempts || 0) * Number(rate.theoreticalGreatSuccessRate || 0);
      }
      return sum;
    },
    { attempts: 0, expected: 0, greatSuccesses: 0 },
  );
}

function mostUsedKit(byKit: DemoKitSummary[]) {
  const [firstKitStats, ...remainingKitStats] = byKit;
  if (!firstKitStats) throw new Error("Expected demo kit stats to include at least one kit.");
  return remainingKitStats.reduce(
    (best, item) => (item.attempts > best.attempts ? item : best),
    firstKitStats,
  );
}

function scaleCumulativeByKit(byKit: DemoKitSummary[]) {
  return byKit.map((item) => ({
    ...item,
    attempts: item.attempts * 6,
    pieces: item.pieces * 6,
    events: item.events * 6,
    greatSuccesses: item.greatSuccesses * 6,
  }));
}

export function makeDemoStats(): StatsApiResponse {
  const levelKitStats = makeLevelKitStats();
  const byKit = makeByKit(levelKitStats);
  const segmentStats = makeSegmentStats(levelKitStats);

  const totalAttempts = byKit.reduce((sum, item) => sum + item.attempts, 0);
  const totalEvents = segmentStats.reduce((sum, item) => sum + item.events, 0);
  const totalGreatSuccesses = byKit.reduce((sum, item) => sum + item.greatSuccesses, 0);
  const mostUsed = mostUsedKit(byKit);
  const cumulativeByKit = scaleCumulativeByKit(byKit);
  const cumulativeAttempts = cumulativeByKit.reduce((sum, item) => sum + item.attempts, 0);
  const cumulativeEvents = segmentStats.reduce((sum, item) => sum + item.events * 6, 0);
  const cumulativeGreatSuccesses = cumulativeByKit.reduce(
    (sum, item) => sum + item.greatSuccesses,
    0,
  );
  const cumulativeMostUsed = mostUsedKit(cumulativeByKit);

  return {
    windowDays: 0,
    today: "2026-05-07",
    dateContract: {
      legacy: {
        id: "kst_calendar_date_v1",
        boundary: "00:00:00+09:00",
        acceptsNewWrites: false,
      },
      current: {
        id: "kst_game_day_0500_v2",
        boundary: "05:00:00+09:00",
        acceptsNewWrites: true,
      },
      cumulativeIncludes: ["kst_calendar_date_v1", "kst_game_day_0500_v2"],
      todayBasis: "kst_game_day_0500_v2",
    },
    summary: {
      events: totalEvents,
      attempts: totalAttempts,
      greatSuccesses: totalGreatSuccesses,
      greatSuccessRate: totalAttempts ? totalGreatSuccesses / totalAttempts : 0,
      todayEvents: 74,
      todayAttempts: 268,
      todayGreatSuccesses: 81,
      mostUsedKit: mostUsed.kit,
      mostUsedKitPieces: mostUsed.attempts * 10,
    },
    byKit,
    cumulative: {
      summary: {
        events: cumulativeEvents,
        attempts: cumulativeAttempts,
        greatSuccesses: cumulativeGreatSuccesses,
        greatSuccessRate: cumulativeAttempts ? cumulativeGreatSuccesses / cumulativeAttempts : 0,
        mostUsedKit: cumulativeMostUsed.kit,
        mostUsedKitPieces: cumulativeMostUsed.attempts * 10,
      },
      byKit: cumulativeByKit,
    },
    levelKitStats,
    segmentStats,
    successAttemptDistribution: [],
  };
}
