import type { WireQ } from "../../shared/certifiedRational";
import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { CohortTuple, DispatchCohort } from "../../shared/certifiedSupplyLaws";
import type { PublicationBytes } from "../../shared/forecastPublicationBytes";

export type Triple = readonly [number, number, number];
export type ExactTriple = readonly [WireQ, WireQ, WireQ];
export interface CertifiedRiskSummaries {
  schemaVersion: 1;
  policyVersion: "experimental-w-selector-v1";
  horizonDays: 14;
  records: readonly {
    day: number;
    meanSuccessP: WireQ;
    insufficientGainMass: WireQ;
    noFurtherWaitCertifiedMass: WireQ;
    renewedWaitUpperBound: WireQ;
  }[];
}
type CertifiedKit = "blue" | "purple" | "yellow";

export interface CertifiedInput {
  /** Internal default-off risk-qualified selector; never a frontend option. */
  stableRecommendation?: import("../certifiedRecommendation/stablePolicy").StableRiskPolicy;
  target?: { version: "target-v1"; alpha: WireQ; maxDays?: number };
  /** Internal opt-in to retain already completed date evidence; never a user target. */
  autoRecommendation?: boolean;
  /** Internal bounded summary opt-in; does not select a recommendation policy. */
  riskSummary?: boolean;
  grade: "R" | "SR";
  level: number;
  exp: number;
  stock: Triple;
  asOf: string;
  snapshot: CertifiedSupplySnapshot;
  forecastPublication?: PublicationBytes;
  /** Explicit unsigned local policy; omitted means approved authority/publication. */
  forecastSource?: "local";
  cohortWeights?: CohortTuple<WireQ>;
  receivedEventIds?: readonly string[];
  /** Original raw stock for fixed prices across a closed-loop execution. */
  priceBasisStock?: Triple;
  computeWaiting?: boolean;
  /** Independent seven-day batch label; enabled by default for v2 Rust requests. */
  computeMinimumWait?: boolean;
  batchLimit?: number;
}

/** Internal request-owned admission handle; never serialized onto the wire. */
export interface CertifiedEvidenceBudget {
  check(): void;
  reserve(bytes: number): void;
  release(bytes: number): void;
}

/** Compatibility name for the existing target consumer. */
export type CertifiedTargetBudget = CertifiedEvidenceBudget;

export interface CertifiedOptions {
  /** Target-only hook, called once before current callbacks with the existing request budget. */
  onTargetBudget?: (budget: CertifiedTargetBudget) => void;
  /** Target OR auto opt-in: the same request budget, before Current callbacks and after return. */
  onEvidenceBudget?: (budget: CertifiedEvidenceBudget) => void;
  /** Monotonic deadline, including the time already spent in the worker queue and initialization. */
  deadlineAt?: number;
  /** Lower test/work admission limits may be selected; neither may exceed the production ceilings. */
  maxMemoEntries?: number;
  maxSupportPoints?: number;
  /** Standalone ceiling 192 MiB; managed workers reserve separate boundary headroom. */
  maxManagedPayloadBytes?: number;
  /** Current first, then a bound minimum-wait/tie update before H14 work. */
  onCurrent?: (partial: CertifiedOutput) => void;
}

export interface CertifiedValue {
  successP: WireQ;
  weightedExpectedConsumptionB: WireQ;
  expectedTotalConsumptionC: WireQ;
  expectedConsumed: ExactTriple;
  display: {
    successP: number;
    weightedExpectedConsumptionB: number;
    expectedTotalConsumptionC: number;
  };
}

export interface CertifiedCurrent {
  status: "use_certified" | "preserve" | "complete";
  value: CertifiedValue;
  kit: CertifiedKit | null;
  optimalActionMask: number;
  /** Stop on a great success or a level change; the normal-path prefix uses the same fixed prices. */
  uses: number;
  pieces: number;
  certification: "exact_rational_finite_inventory_v1";
}

export interface CertifiedWaiting {
  status: "certified" | "unresolved" | "claim_required" | "not_requested";
  horizonDays: 14;
  recommendedDays: number | null;
  rangeBoundary: boolean;
  bestDayRange: readonly [number, number] | null;
  /**
   * When non-null, exact P/B/C and per-color expected consumption at recommendedDays,
   * including day 0; never substitute the horizon vector merely because P/B/C tie.
   * Null when that day's exact value is not computed (including boundary witnesses).
   */
  value: CertifiedValue | null;
  evaluatedDays: readonly number[];
  /** Certified upper bound on success-probability improvement after H; never an MC estimate. */
  successImprovementUpperBound: WireQ | null;
  successProbabilityInterval: { lower: WireQ; upper: WireQ } | null;
  strictBoundaryWitness?: {
    cohort: DispatchCohort;
    receipts: readonly { eventId: string; refIndex: number; pieces: Triple; mass: WireQ }[];
    beforeStock: Triple;
    afterStock: Triple;
    beforeValue: CertifiedValue;
    afterValue: CertifiedValue;
  };
  reason: string | null;
  evidence: readonly string[];
}

export interface CertifiedMinimumWait {
  version: "certified-minimum-wait-v1";
  status: "certified" | "beyond_horizon" | "unknown" | "not_applicable" | "not_requested";
  kit: CertifiedCurrent["kit"];
  uses: number;
  pieces: number;
  thresholdDays: WireQ;
  horizonDays: 7;
  minimumDays: number | null;
  earliestPossibleDay: number | null;
  latestPossibleDay: number | null;
  evaluatedDays: readonly number[];
  mixedDailyRate: ExactTriple | null;
  reason: string | null;
  evidence: readonly string[];
}

export interface CertifiedMinimumWaitProbe {
  version: "certified-minimum-wait-probe-v1";
  status: "EXACT" | "NOTRUN";
  recommendation: { kit: CertifiedCurrent["kit"]; uses: number };
  label: number | "7+" | "unknown";
  certificateApplies: boolean;
  certificateShortcutUsed: boolean;
  classifierCaps: Triple;
  supportUnitsCapped: false;
  reason: string | null;
  complete: boolean;
  perDay: readonly {
    day: number;
    crossing: boolean;
    crossingUnits: readonly Triple[];
    supportUnits: readonly Triple[];
  }[];
  minimumWait?: CertifiedMinimumWait;
}

export interface CertifiedOutput {
  riskSummaries?: CertifiedRiskSummaries;
  target?: CertifiedTarget;
  /**
   * Internal auto-only final evidence; absent from Current callbacks, claim-gated
   * results and failed evidence production. D0 is the final post-H7 Current.
   * A successful waiting adapter return (including unresolved completed prefixes)
   * or explicit waiting skip publishes 1..15 records once binding succeeds.
   * A thrown failure may preserve partial Current without this envelope; absence
   * is not an empty record set and must not be repaired into evidence by consumers.
   * Runtime owns identity binding and recommendation policy; never infer missing dates.
   */
  completedEvidence?: { schemaVersion: 1; records: readonly CompletedDate[] };
  status: "completed" | "partial" | "refused";
  current: CertifiedCurrent | null;
  waiting: CertifiedWaiting;
  /** Optional for historical/reference outputs; never inferred from the H14 result. */
  minimumWait?: CertifiedMinimumWait;
  refusal: {
    reason: string;
    phase: "input" | "pricing" | "current" | "minimum_wait" | "waiting";
  } | null;
  claimNotice: { eventIds: readonly string[]; message: string } | null;
  pricing: {
    basisStock: Triple;
    recurringRate: ExactTriple;
    weights: ExactTriple;
    cohortWeights: CohortTuple<WireQ>;
  } | null;
  provenance: {
    solverVersion: "certified-exact-js-v1" | "certified-exact-rust-wasm-v1";
    arithmetic: "exact_bigint_ladder_reduced_public_rationals";
    calculationGraph: "repeated_exact_date_expectations_shared_finite_memo";
    requestBudgetMs: 15000;
    horizonMeaning: "range_only_no_deadline";
    snapshotRevision: string;
    snapshotSourceHash: string;
    objective: "max_P_min_B_min_C_exact_earliest_date";
  };
  diagnostics: {
    elapsedMs: number;
    memoEntries: number;
    exactTransitions: number;
    supportPeakPoints: number;
    managedPayloadBytes: number;
    managedPayloadDefinition: string;
    unmeasuredMemory: readonly string[];
    wasmMemoryBytes: number;
    kernelCalls: number;
  };
}

export interface CompletedDate {
  day: number;
  value: CertifiedValue;
}

export interface CertifiedTarget {
  version: "target-v1";
  alpha: WireQ;
  maxDays: number;
  status: "certified" | "not_reached_within_limit" | "unresolved" | "claim_required";
  minimumDays: number | null;
  /** Exact probabilities only; selected vector is retained once, below. */
  probabilities: readonly { day: number; successP: WireQ }[];
  earliestNotRuledOutDay: number | null;
  attainedByDay: number | null;
  /** Actual contiguous completed prefix of the whole H14 calculation from canonical D0; may exceed target maxDays; null before claim gate. */
  completedThroughDay: number | null;
  value: CertifiedValue | null;
  reason: string | null;
}
