/** Contract-shaped output builders for the certified lane spec. Values come from the
 * public src/certified/types.ts contract, never from candidate output. */
import type {
  CertifiedCurrent,
  CertifiedInput,
  CertifiedOutput,
  CertifiedValue,
  CertifiedWaiting,
} from "../src/certified/types.ts";
import { approx, type ExactQ, type QTriple, wire } from "./certified-staging-oracle.ts";
import { mapTriple } from "./certified-staging-oracle-tuples.ts";

export const NOT_REQUESTED: CertifiedWaiting = {
  status: "not_requested",
  horizonDays: 14,
  recommendedDays: null,
  rangeBoundary: false,
  bestDayRange: null,
  value: null,
  evaluatedDays: [],
  successImprovementUpperBound: null,
  successProbabilityInterval: null,
  reason: null,
  evidence: [],
};

export function certifiedValue(P: ExactQ, B: ExactQ, C: ExactQ, consumed: QTriple): CertifiedValue {
  return {
    successP: wire(P),
    weightedExpectedConsumptionB: wire(B),
    expectedTotalConsumptionC: wire(C),
    expectedConsumed: mapTriple(consumed, wire),
    display: {
      successP: approx(P),
      weightedExpectedConsumptionB: approx(B),
      expectedTotalConsumptionC: approx(C),
    },
  };
}
// Contract mapping from src/certified/types.ts, not from candidate output.
export function statusOf(
  input: Pick<CertifiedInput, "grade" | "level">,
  kit: CertifiedCurrent["kit"],
): CertifiedCurrent["status"] {
  if (input.grade === "SR" && input.level === 15) return "complete";
  return kit ? "use_certified" : "preserve";
}
export function current(
  value: CertifiedValue,
  mask: number,
  kit: CertifiedCurrent["kit"],
  status: CertifiedCurrent["status"],
  uses = 0,
): CertifiedCurrent {
  return {
    status,
    value,
    kit,
    optimalActionMask: mask,
    uses,
    pieces: uses * 10,
    certification: "exact_rational_finite_inventory_v1",
  };
}
export function output(patch: Partial<CertifiedOutput>): CertifiedOutput {
  return {
    status: "completed",
    current: null,
    waiting: NOT_REQUESTED,
    refusal: null,
    claimNotice: null,
    pricing: null,
    provenance: {
      solverVersion: "certified-exact-js-v1",
      arithmetic: "exact_bigint_ladder_reduced_public_rationals",
      calculationGraph: "repeated_exact_date_expectations_shared_finite_memo",
      requestBudgetMs: 15000,
      horizonMeaning: "range_only_no_deadline",
      snapshotRevision: "lane-test",
      snapshotSourceHash: "lane-test",
      objective: "max_P_min_B_min_C_exact_earliest_date",
    },
    diagnostics: {
      elapsedMs: 0,
      memoEntries: 0,
      exactTransitions: 0,
      supportPeakPoints: 0,
      managedPayloadBytes: 0,
      managedPayloadDefinition: "lane-test",
      unmeasuredMemory: [],
      wasmMemoryBytes: 0,
      kernelCalls: 0,
    },
    ...patch,
  };
}
export const fail = (reason: string) => ({ status: "FAIL", reason });
export const bump = (value: { numerator: string; denominator: string }) => ({
  ...value,
  numerator: String(BigInt(value.numerator) + 1n),
});
