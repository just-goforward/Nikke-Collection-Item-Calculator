import * as z from "zod/mini";

const GradeSchema = z.enum(["R", "SR"]);
const KitSchema = z.enum(["blue", "purple", "yellow"]);
const StatisticsDateBasisSchema = z.enum(["kst_calendar_date_v1", "kst_game_day_0500_v2"]);

const NumericStatsSchema = z.looseObject({
  events: z.number(),
  attempts: z.number(),
  pieces: z.optional(z.number()),
  greatSuccesses: z.number(),
  greatSuccessRate: z.optional(z.number()),
  theoreticalGreatSuccessRate: z.optional(z.number()),
});

const LevelKitValueSchema = z.looseObject({
  attempts: z.number(),
  pieces: z.optional(z.number()),
  greatSuccesses: z.number(),
  greatSuccessRate: z.number(),
  theoreticalGreatSuccessRate: z.number(),
});

const StatsSummarySchema = z.looseObject({
  events: z.number(),
  attempts: z.number(),
  greatSuccesses: z.number(),
  greatSuccessRate: z.number(),
  todayEvents: z.optional(z.number()),
  todayAttempts: z.optional(z.number()),
  todayGreatSuccesses: z.optional(z.number()),
  mostUsedKit: z.optional(z.nullable(KitSchema)),
  mostUsedKitPieces: z.optional(z.number()),
});

const KitStatsSchema = z.extend(NumericStatsSchema, {
  kit: KitSchema,
  theoreticalGreatSuccessRate: z.number(),
});

export const StatsApiResponseSchema = z.looseObject({
  windowDays: z.number(),
  today: z.string(),
  dateContract: z.optional(
    z.looseObject({
      legacy: z.looseObject({
        id: z.literal("kst_calendar_date_v1"),
        boundary: z.literal("00:00:00+09:00"),
        acceptsNewWrites: z.literal(false),
      }),
      current: z.looseObject({
        id: z.literal("kst_game_day_0500_v2"),
        boundary: z.literal("05:00:00+09:00"),
        acceptsNewWrites: z.literal(true),
      }),
      cumulativeIncludes: z.array(StatisticsDateBasisSchema),
      todayBasis: z.literal("kst_game_day_0500_v2"),
    }),
  ),
  summary: z.extend(StatsSummarySchema, {
    todayEvents: z.number(),
    todayAttempts: z.number(),
    todayGreatSuccesses: z.number(),
    mostUsedKit: z.nullable(KitSchema),
    mostUsedKitPieces: z.number(),
  }),
  byKit: z.array(KitStatsSchema),
  cumulative: z.optional(
    z.looseObject({
      summary: StatsSummarySchema,
      byKit: z.array(KitStatsSchema),
    }),
  ),
  levelKitStats: z._default(
    z.optional(
      z.array(
        z.looseObject({
          grade: GradeSchema,
          level: z.number(),
          kits: z.looseObject({
            blue: LevelKitValueSchema,
            purple: LevelKitValueSchema,
            yellow: LevelKitValueSchema,
          }),
        }),
      ),
    ),
    [],
  ),
  segmentStats: z.array(
    z.extend(NumericStatsSchema, {
      key: z.string(),
      label: z.string(),
      theoreticalGreatSuccessRate: z.number(),
      averageAttempts: z.number(),
      byKit: z.optional(z.array(KitStatsSchema)),
    }),
  ),
  successAttemptDistribution: z._default(
    z.optional(
      z.array(
        z.looseObject({
          kit: KitSchema,
          successAttempt: z.number(),
          events: z.number(),
        }),
      ),
    ),
    [],
  ),
});

export type StatsApiResponse = z.infer<typeof StatsApiResponseSchema>;
