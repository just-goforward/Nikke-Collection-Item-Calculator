import z from "zod/v4";
import {
  BLUE_SHARE_BUCKETS,
  CANDIDATE_COUNT_BUCKETS,
  COMPARISON_BUCKETS,
  LEGACY_STOCK_BUCKETS,
  MEMO_TIER_BUCKETS,
  MIN_AUTONOMY_DAYS_BUCKETS,
  NODE_COUNT_BUCKETS,
  PROBABILITY_GAP_BUCKETS,
  RECOMMENDED_USES_BUCKETS,
  RESOURCE_COST_BUCKETS,
  RETRY_BUCKETS,
  SOLVE_MS_BUCKETS,
  SOLVER_EXECUTION_KINDS,
  STATS_LOCALES,
  STOCK_BUCKETS,
  TOTAL_EXPECTED_COST_BUCKETS,
} from "../../shared/statsContract";
import { WORKER_ERROR_CODES } from "../../shared/workerProtocol";

const GradeSchema = z.enum(["R", "SR"]);
const KitSchema = z.enum(["blue", "purple", "yellow"]);
const StrategySchema = z.enum(["single", "supply"]);
const EventIdSchema = z.string().regex(/^[a-zA-Z0-9-]{16,80}$/);
const StockValueSchema = z.number().int().min(0).max(100_000);

const CollectionStateSchema = z
  .object({
    grade: GradeSchema,
    level: z.number().int().min(0).max(15),
    exp: z.number().int().min(0).max(2_900),
  })
  .passthrough();

const StockSchema = z
  .object({
    blue: StockValueSchema,
    purple: StockValueSchema,
    yellow: StockValueSchema,
  })
  .passthrough();

const KitResultEventSchema = z
  .object({
    kind: z.literal("kit_result"),
    start: CollectionStateSchema,
    kit: KitSchema,
    recommendedUses: z.number().int().min(1).max(100),
    strategy: StrategySchema.optional(),
    outcome: z.enum(["great_success", "no_great_success"]),
    successAttempt: z.number().int().min(1).max(100).nullable().optional(),
    stockBefore: StockSchema,
    stockAfter: StockSchema,
    resultState: CollectionStateSchema,
  })
  .passthrough();

const LegacyStockBucketSchema = z.enum(LEGACY_STOCK_BUCKETS);
const StockBucketV2Schema = z.enum(STOCK_BUCKETS);
const StockBucketSchema = z.union([LegacyStockBucketSchema, StockBucketV2Schema]);
const RecommendedUsesBucketSchema = z.enum(RECOMMENDED_USES_BUCKETS);
const CandidateCountBucketSchema = z.enum(CANDIDATE_COUNT_BUCKETS);
const ProbabilityGapBucketSchema = z.enum(PROBABILITY_GAP_BUCKETS);
const ResourceCostBucketSchema = z.enum(RESOURCE_COST_BUCKETS);
const TotalExpectedCostBucketSchema = z.enum(TOTAL_EXPECTED_COST_BUCKETS);
const BlueShareBucketSchema = z.enum(BLUE_SHARE_BUCKETS);
const MinAutonomyDaysBucketSchema = z.enum(MIN_AUTONOMY_DAYS_BUCKETS);
const NodeCountBucketSchema = z.enum(NODE_COUNT_BUCKETS);
const SolveMsBucketSchema = z.enum(SOLVE_MS_BUCKETS);
const ComparisonBucketSchema = z.enum(COMPARISON_BUCKETS);
const MemoryStrategySchema = z.string().trim().min(1).max(64).optional();
const MemoTierSchema = z.enum(MEMO_TIER_BUCKETS).optional();
const Phase2MemoRetriedSchema = z.enum(RETRY_BUCKETS).optional();
const SolverExecutionKindSchema = z.enum(SOLVER_EXECUTION_KINDS).optional();
const StatsLocaleSchema = z.enum(STATS_LOCALES);
const SolverBackendSchema = z.enum(["js-phase2", "rust-phase2", "rust-min-ef"]);
const SolverRecoveryExitSchema = z.enum(["not_attempted", "success", ...WORKER_ERROR_CODES]);

const SolverDiagnosticEventSchema = z
  .object({
    kind: z.literal("solver_diagnostic"),
    diagnosticVersion: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
    ]),
    locale: StatsLocaleSchema.optional(),
    solverVersion: z.string(),
    solverPhase: z.string(),
    solverBackend: z.string().optional(),
    requestedBackend: z.string().optional(),
    executionKind: SolverExecutionKindSchema,
    fallbackFrom: z.string().optional(),
    fallbackReason: z.string().optional(),
    workerErrorCode: z.string().optional(),
    memoryStrategy: MemoryStrategySchema,
    minEfMemoTier: MemoTierSchema,
    phase2MemoTier: MemoTierSchema,
    phase2MemoRetried: Phase2MemoRetriedSchema,
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
    attemptedNodeCountBucket: NodeCountBucketSchema.optional(),
    solveMsBucket: SolveMsBucketSchema.optional(),
    changedFromSingle: ComparisonBucketSchema,
    changedFromLegacySupply: ComparisonBucketSchema,
    legacyPrivateStatsAvailable: z.boolean(),
    legacyEventAggregateMatchable: z.boolean(),
  })
  .passthrough();

const SolverRecoveryEventSchema = z
  .object({
    kind: z.literal("solver_recovery"),
    recoveryVersion: z.literal(1),
    policyVersion: z.literal("ladder_v1"),
    requestedBackend: SolverBackendSchema,
    minEfExit: SolverRecoveryExitSchema,
    phase2Exit: SolverRecoveryExitSchema,
    jsExit: SolverRecoveryExitSchema,
    terminalBackend: z.union([SolverBackendSchema, z.literal("none")]),
    terminalOutcome: z.enum(["success", "failure"]),
    minEfMemoTier: z.enum(MEMO_TIER_BUCKETS),
    phase2MemoTier: z.enum(MEMO_TIER_BUCKETS),
    start: CollectionStateSchema,
    stockBuckets: z
      .object({
        blue: StockBucketSchema,
        purple: StockBucketSchema,
        yellow: StockBucketSchema,
      })
      .passthrough(),
  })
  .passthrough();

export const EventSubmissionSchema = z
  .object({
    version: z.literal(1),
    eventId: EventIdSchema,
    clientTime: z.string().datetime().optional(),
    sourceHost: z.string().optional(),
    turnstileToken: z.string().min(20).max(2048),
    event: z.discriminatedUnion("kind", [
      KitResultEventSchema,
      SolverDiagnosticEventSchema,
      SolverRecoveryEventSchema,
    ]),
  })
  .passthrough();

export type EventSubmission = z.infer<typeof EventSubmissionSchema>;
type EventSubmissionEvent = EventSubmission["event"];
export type KitResultEventInput = Extract<EventSubmissionEvent, { kind: "kit_result" }>;
export type SolverDiagnosticEventInput = Extract<
  EventSubmissionEvent,
  { kind: "solver_diagnostic" }
>;
export type SolverRecoveryEventInput = Extract<EventSubmissionEvent, { kind: "solver_recovery" }>;
