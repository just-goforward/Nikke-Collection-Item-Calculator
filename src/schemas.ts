import z from "zod/v4";

export const GradeSchema = z.enum(["R", "SR"]);
export const KitSchema = z.enum(["blue", "purple", "yellow"]);
export const StrategySchema = z.enum(["single", "supply"]);

export const CollectionStateSchema = z
  .object({
    grade: GradeSchema,
    level: z.number(),
    exp: z.number(),
  })
  .passthrough();

export const StockSchema = z
  .object({
    blue: z.number(),
    purple: z.number(),
    yellow: z.number(),
  })
  .passthrough();

export const SolverInputSchema = z
  .object({
    start: CollectionStateSchema,
    stock: StockSchema,
    strategy: StrategySchema.optional(),
    monteCarloRuns: z.number().optional(),
    monteCarloSeed: z.number().optional(),
  })
  .passthrough();

export const StatsConfigSchema = z
  .object({
    endpoint: z.string().trim().url().optional(),
    turnstileSiteKey: z.string().trim().min(1).optional(),
    staging: z
      .object({
        endpoint: z.string().trim().url().optional(),
        turnstileSiteKey: z.string().trim().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const ProgressEventSchema = z
  .object({
    phase: z.string(),
    scanned: z.number().optional(),
    total: z.number().nullable().optional(),
  })
  .passthrough();

export const WorkerRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("solve"),
      id: z.number(),
      input: SolverInputSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("validate"),
      id: z.number(),
      input: SolverInputSchema,
      runs: z.number().optional(),
      seed: z.number().optional(),
    })
    .passthrough(),
]);

export const WorkerResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("progress"),
      id: z.number(),
      progress: ProgressEventSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("result"),
      id: z.number(),
      result: z.unknown(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("error"),
      id: z.number(),
      message: z.string(),
    })
    .passthrough(),
]);

const NumericStatsSchema = z
  .object({
    events: z.number(),
    attempts: z.number(),
    greatSuccesses: z.number(),
    greatSuccessRate: z.number().optional(),
    theoreticalGreatSuccessRate: z.number().optional(),
  })
  .passthrough();

const LevelKitValueSchema = z
  .object({
    attempts: z.number(),
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
