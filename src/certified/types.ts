import type { WireQ } from "../../shared/certifiedRational";
import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { CohortTuple, DispatchCohort } from "../../shared/certifiedSupplyLaws";
import type { PublicationBytes } from "../../shared/forecastPublicationBytes";

export type Triple = readonly [number, number, number];
export type ExactTriple = readonly [WireQ, WireQ, WireQ];
type CertifiedKit = "blue" | "purple" | "yellow";

export interface CertifiedInput {
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

export interface CertifiedOptions {
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
