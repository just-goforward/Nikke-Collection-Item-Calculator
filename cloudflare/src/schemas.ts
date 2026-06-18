import z from "zod/v4";

const GradeSchema = z.enum(["R", "SR"]);
const KitSchema = z.enum(["blue", "purple", "yellow"]);
const StrategySchema = z.enum(["single", "supply"]);

const CollectionStateSchema = z
  .object({
    grade: GradeSchema,
    level: z.number(),
    exp: z.number(),
  })
  .passthrough();

const StockSchema = z
  .object({
    blue: z.number(),
    purple: z.number(),
    yellow: z.number(),
  })
  .passthrough();

const KitResultEventSchema = z
  .object({
    kind: z.literal("kit_result"),
    start: CollectionStateSchema,
    kit: KitSchema,
    recommendedUses: z.number(),
    strategy: StrategySchema.optional(),
    outcome: z.enum(["great_success", "no_great_success"]),
    successAttempt: z.number().nullable().optional(),
    stockBefore: StockSchema,
    stockAfter: StockSchema,
    resultState: CollectionStateSchema,
  })
  .passthrough();

const LegacyStockBucketSchema = z.enum(["0", "1_9", "10_49", "50_99", "100_299", "300_plus"]);
const StockBucketV2Schema = z.enum([
  "0",
  "1_49",
  "50_99",
  "100_149",
  "150_199",
  "200_249",
  "250_299",
  "300_349",
  "350_399",
  "400_449",
  "450_499",
  "500_plus",
]);
const StockBucketSchema = z.union([LegacyStockBucketSchema, StockBucketV2Schema]);
const RecommendedUsesBucketSchema = z.enum(["1", "2", "3_4", "5_9", "10_14", "15_plus"]);
const CandidateCountBucketSchema = z.enum(["0", "1", "2", "3_plus"]);
const ProbabilityGapBucketSchema = z.enum([
  "0",
  "0_0_1pp",
  "0_1_0_3pp",
  "0_3_0_7pp",
  "0_7_1_0pp",
  "gt_1_0pp",
]);
const ResourceCostBucketSchema = z.enum([
  "0",
  "0_0_05",
  "0_05_0_1",
  "0_1_0_25",
  "0_25_0_5",
  "0_5_1",
  "1_plus",
]);
const TotalExpectedCostBucketSchema = z.enum(["0_49", "50_99", "100_199", "200_399", "400_plus"]);
const BlueShareBucketSchema = z.enum(["0_30", "30_50", "50_70", "70_90", "90_100"]);
const MinAutonomyDaysBucketSchema = z.enum(["lt_0", "0_3", "3_7", "7_14", "14_28", "28_plus"]);
const NodeCountBucketSchema = z.enum([
  "0",
  "1_99",
  "100_999",
  "1000_9999",
  "10000_99999",
  "100000_499999",
  "500000_999999",
  "1000000_plus",
]);
const ComparisonBucketSchema = z.enum(["yes", "no", "unknown", "not_applicable"]);

const SolverDiagnosticEventSchema = z
  .object({
    kind: z.literal("solver_diagnostic"),
    diagnosticVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    solverVersion: z.string(),
    solverPhase: z.string(),
    start: CollectionStateSchema,
    strategy: StrategySchema,
    stockBuckets: z
      .object({
        blue: StockBucketSchema,
        purple: StockBucketSchema,
        yellow: StockBucketSchema,
      })
      .passthrough(),
    recommendedKit: KitSchema,
    recommendedUsesBucket: RecommendedUsesBucketSchema,
    candidateCountBucket: CandidateCountBucketSchema,
    probabilityGapBucket: ProbabilityGapBucketSchema,
    resourceCostBucket: ResourceCostBucketSchema,
    legacySupplyCostBucket: ResourceCostBucketSchema,
    totalExpectedCostBucket: TotalExpectedCostBucketSchema,
    blueShareBucket: BlueShareBucketSchema,
    minAutonomyDaysBucket: MinAutonomyDaysBucketSchema,
    nodeCountBucket: NodeCountBucketSchema.optional(),
    changedFromSingle: ComparisonBucketSchema,
    changedFromLegacySupply: ComparisonBucketSchema,
    legacyPrivateStatsAvailable: z.boolean(),
    legacyEventAggregateMatchable: z.boolean(),
  })
  .passthrough();

export const EventSubmissionSchema = z
  .object({
    version: z.literal(1),
    eventId: z.string(),
    clientTime: z.string().optional(),
    sourceHost: z.string().optional(),
    turnstileToken: z.string(),
    event: z.discriminatedUnion("kind", [KitResultEventSchema, SolverDiagnosticEventSchema]),
  })
  .passthrough();
