import * as z from "zod/mini";
import { MAX_STOCK_PIECES } from "../../shared/game";
import {
  BLUE_SHARE_BUCKETS,
  CANDIDATE_COUNT_BUCKETS,
  COMPARISON_BUCKETS,
  isSolverDiagnosticVersion,
  LEGACY_STOCK_BUCKETS,
  MEMO_TIER_BUCKETS,
  MIN_AUTONOMY_DAYS_BUCKETS,
  NODE_COUNT_BUCKETS,
  PROBABILITY_GAP_BUCKETS,
  RECOMMENDED_USES_BUCKETS,
  RESOURCE_COST_BUCKETS,
  RETRY_BUCKETS,
  RUNTIME_INVARIANT_CODES,
  RUNTIME_INVARIANT_COMPONENTS,
  RUNTIME_INVARIANT_LANES,
  RUNTIME_INVARIANT_VERSION,
  SOLVE_MS_BUCKETS,
  SOLVER_EXECUTION_KINDS,
  type SolverDiagnosticVersion,
  STATS_LOCALES,
  STOCK_BUCKETS,
  TOTAL_EXPECTED_COST_BUCKETS,
} from "../../shared/statsContract";
import { WORKER_ERROR_CODES } from "../../shared/workerProtocol";

const GradeSchema = z.enum(["R", "SR"]);
const KitSchema = z.enum(["blue", "purple", "yellow"]);
const StrategySchema = z.enum(["single", "supply"]);
const EventIdSchema = z.string().check(z.regex(/^[a-zA-Z0-9-]{16,80}$/));
const StockValueSchema = z.int().check(z.minimum(0), z.maximum(MAX_STOCK_PIECES));

const CollectionStateSchema = z.looseObject({
  grade: GradeSchema,
  level: z.int().check(z.minimum(0), z.maximum(15)),
  exp: z.int().check(z.minimum(0), z.maximum(2_900)),
});

const StockSchema = z.looseObject({
  blue: StockValueSchema,
  purple: StockValueSchema,
  yellow: StockValueSchema,
});

const KitResultEventSchema = z.looseObject({
  kind: z.literal("kit_result"),
  start: CollectionStateSchema,
  kit: KitSchema,
  recommendedUses: z.int().check(z.minimum(1), z.maximum(100)),
  strategy: z.optional(StrategySchema),
  outcome: z.enum(["great_success", "no_great_success"]),
  successAttempt: z.optional(z.nullable(z.int().check(z.minimum(1), z.maximum(100)))),
  stockBefore: StockSchema,
  stockAfter: StockSchema,
  resultState: CollectionStateSchema,
});

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
const MemoryStrategySchema = z.optional(
  z.string().check(z.trim(), z.minLength(1), z.maxLength(64)),
);
const MemoTierSchema = z.optional(z.enum(MEMO_TIER_BUCKETS));
const Phase2MemoRetriedSchema = z.optional(z.enum(RETRY_BUCKETS));
const SolverExecutionKindSchema = z.optional(z.enum(SOLVER_EXECUTION_KINDS));
const SupplyForecastIdSchema = z.optional(
  z.string().check(z.trim(), z.minLength(1), z.maxLength(64)),
);
const SupplyForecastProfileIdSchema = z.optional(
  z.string().check(z.trim(), z.minLength(1), z.maxLength(96)),
);
const StatsLocaleSchema = z.enum(STATS_LOCALES);
const SolverBackendSchema = z.enum(["js-phase2", "rust-phase2", "rust-min-ef"]);
const SolverRecoveryExitSchema = z.enum(["not_attempted", "success", ...WORKER_ERROR_CODES]);

const StockBucketsSchema = z.looseObject({
  blue: StockBucketSchema,
  purple: StockBucketSchema,
  yellow: StockBucketSchema,
});

const SolverDiagnosticEventSchema = z.looseObject({
  kind: z.literal("solver_diagnostic"),
  diagnosticVersion: z.custom<SolverDiagnosticVersion>(isSolverDiagnosticVersion),
  forecastId: SupplyForecastIdSchema,
  forecastProfileId: SupplyForecastProfileIdSchema,
  locale: z.optional(StatsLocaleSchema),
  solverVersion: z.string(),
  solverPhase: z.string(),
  solverBackend: z.optional(z.string()),
  requestedBackend: z.optional(z.string()),
  executionKind: SolverExecutionKindSchema,
  fallbackFrom: z.optional(z.string()),
  fallbackReason: z.optional(z.string()),
  workerErrorCode: z.optional(z.string()),
  memoryStrategy: MemoryStrategySchema,
  minEfMemoTier: MemoTierSchema,
  phase2MemoTier: MemoTierSchema,
  phase2MemoRetried: Phase2MemoRetriedSchema,
  start: CollectionStateSchema,
  strategy: StrategySchema,
  stockBuckets: StockBucketsSchema,
  recommendedKit: KitSchema,
  recommendedUsesBucket: RecommendedUsesBucketSchema,
  candidateCountBucket: CandidateCountBucketSchema,
  probabilityGapBucket: ProbabilityGapBucketSchema,
  resourceCostBucket: ResourceCostBucketSchema,
  legacySupplyCostBucket: ResourceCostBucketSchema,
  totalExpectedCostBucket: TotalExpectedCostBucketSchema,
  blueShareBucket: BlueShareBucketSchema,
  minAutonomyDaysBucket: MinAutonomyDaysBucketSchema,
  nodeCountBucket: z.optional(NodeCountBucketSchema),
  attemptedNodeCountBucket: z.optional(NodeCountBucketSchema),
  solveMsBucket: z.optional(SolveMsBucketSchema),
  changedFromSingle: ComparisonBucketSchema,
  changedFromLegacySupply: ComparisonBucketSchema,
  legacyPrivateStatsAvailable: z.boolean(),
  legacyEventAggregateMatchable: z.boolean(),
});

const SolverRecoveryEventSchema = z.looseObject({
  kind: z.literal("solver_recovery"),
  recoveryVersion: z.literal(1),
  forecastId: SupplyForecastIdSchema,
  forecastProfileId: SupplyForecastProfileIdSchema,
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
  stockBuckets: StockBucketsSchema,
});

const RuntimeInvariantEventSchema = z.strictObject({
  kind: z.literal("runtime_invariant"),
  invariantVersion: z.literal(RUNTIME_INVARIANT_VERSION),
  code: z.enum(RUNTIME_INVARIANT_CODES),
  component: z.enum(RUNTIME_INVARIANT_COMPONENTS),
  lane: z.enum(RUNTIME_INVARIANT_LANES),
});

export const EventSubmissionSchema = z.looseObject({
  version: z.literal(1),
  eventId: EventIdSchema,
  clientTime: z.optional(z.iso.datetime()),
  sourceHost: z.optional(z.string()),
  turnstileToken: z.string().check(z.minLength(20), z.maxLength(2048)),
  event: z.discriminatedUnion("kind", [
    KitResultEventSchema,
    RuntimeInvariantEventSchema,
    SolverDiagnosticEventSchema,
    SolverRecoveryEventSchema,
  ]),
});

export type EventSubmission = z.infer<typeof EventSubmissionSchema>;
type EventSubmissionEvent = EventSubmission["event"];
export type KitResultEventInput = Extract<EventSubmissionEvent, { kind: "kit_result" }>;
export type SolverDiagnosticEventInput = Extract<
  EventSubmissionEvent,
  { kind: "solver_diagnostic" }
>;
export type SolverRecoveryEventInput = Extract<EventSubmissionEvent, { kind: "solver_recovery" }>;
export type RuntimeInvariantEventInput = Extract<
  EventSubmissionEvent,
  { kind: "runtime_invariant" }
>;
