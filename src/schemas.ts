import z from "zod/v4";

const GradeSchema = z.enum(["R", "SR"]);
const KitSchema = z.enum(["blue", "purple", "yellow"]);

const NumericStatsSchema = z
  .object({
    events: z.number(),
    attempts: z.number(),
    pieces: z.number().optional(),
    greatSuccesses: z.number(),
    greatSuccessRate: z.number().optional(),
    theoreticalGreatSuccessRate: z.number().optional(),
  })
  .passthrough();

const LevelKitValueSchema = z
  .object({
    attempts: z.number(),
    pieces: z.number().optional(),
    greatSuccesses: z.number(),
    greatSuccessRate: z.number(),
    theoreticalGreatSuccessRate: z.number(),
  })
  .passthrough();

const StatsSummarySchema = z
  .object({
    events: z.number(),
    attempts: z.number(),
    greatSuccesses: z.number(),
    greatSuccessRate: z.number(),
    todayEvents: z.number().optional(),
    todayAttempts: z.number().optional(),
    todayGreatSuccesses: z.number().optional(),
    mostUsedKit: KitSchema.nullable().optional(),
    mostUsedKitPieces: z.number().optional(),
  })
  .passthrough();

const KitStatsSchema = NumericStatsSchema.extend({
  kit: KitSchema,
  theoreticalGreatSuccessRate: z.number(),
}).passthrough();

export const StatsApiResponseSchema = z
  .object({
    windowDays: z.number(),
    today: z.string(),
    summary: StatsSummarySchema.extend({
      todayEvents: z.number(),
      todayAttempts: z.number(),
      todayGreatSuccesses: z.number(),
      mostUsedKit: KitSchema.nullable(),
      mostUsedKitPieces: z.number(),
    }).passthrough(),
    byKit: z.array(KitStatsSchema),
    cumulative: z
      .object({
        summary: StatsSummarySchema,
        byKit: z.array(KitStatsSchema),
      })
      .passthrough()
      .optional(),
    levelKitStats: z
      .array(
        z
          .object({
            grade: GradeSchema,
            level: z.number(),
            kits: z
              .object({
                blue: LevelKitValueSchema,
                purple: LevelKitValueSchema,
                yellow: LevelKitValueSchema,
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .optional()
      .default([]),
    segmentStats: z.array(
      NumericStatsSchema.extend({
        key: z.string(),
        label: z.string(),
        theoreticalGreatSuccessRate: z.number(),
        averageAttempts: z.number(),
        byKit: z.array(KitStatsSchema).optional(),
      }).passthrough(),
    ),
    successAttemptDistribution: z
      .array(
        z
          .object({
            kit: KitSchema,
            successAttempt: z.number(),
            events: z.number(),
          })
          .passthrough(),
      )
      .optional()
      .default([]),
  })
  .passthrough();

export type StatsApiResponse = z.infer<typeof StatsApiResponseSchema>;
