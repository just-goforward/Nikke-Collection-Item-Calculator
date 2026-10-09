import type { WireQ } from "../../shared/certifiedRational";
import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupply";

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
  cohortWeights?: ExactTriple;
  receivedEventIds?: readonly string[];
  /** Original raw stock for fixed prices across a closed-loop execution. */
  priceBasisStock?: Triple;
  computeWaiting?: boolean;
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
  horizonDays: 56;
  recommendedDays: number | null;
  rangeBoundary: boolean;
  bestDayRange: readonly [number, number] | null;
  value: CertifiedValue | null;
  evaluatedDays: readonly number[];
  /** Certified upper bound on success-probability improvement after H; never an MC estimate. */
  successImprovementUpperBound: WireQ | null;
  successProbabilityInterval: { lower: WireQ; upper: WireQ } | null;
  strictBoundaryWitness?: {
    cohort: 0 | 1 | 2;
    receipts: readonly { eventId: string; refIndex: number; pieces: Triple; mass: WireQ }[];
    beforeStock: Triple;
    afterStock: Triple;
    beforeValue: CertifiedValue;
    afterValue: CertifiedValue;
  };
  reason: string | null;
  evidence: readonly string[];
}

export interface CertifiedOutput {
  status: "completed" | "partial" | "refused";
  current: CertifiedCurrent | null;
  waiting: CertifiedWaiting;
  refusal: { reason: string; phase: "input" | "pricing" | "current" | "waiting" } | null;
  claimNotice: { eventIds: readonly string[]; message: string } | null;
  pricing: {
    basisStock: Triple;
    recurringRate: ExactTriple;
    weights: ExactTriple;
    cohortWeights: ExactTriple;
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
