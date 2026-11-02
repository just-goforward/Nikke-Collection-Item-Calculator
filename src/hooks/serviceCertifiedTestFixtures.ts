import type { CertifiedOutput } from "../certified/types";
import type { StableRuntimeRecommendation } from "../certifiedRecommendation/stableRuntime";
import type { CertifiedRuntimeOutput } from "../certifiedRuntime/outputBinding";
import type { SolverInput } from "../types";

/** Synthetic presentation/transport fixtures; no solver or trust result is asserted by these. */
export const serviceTestInput: SolverInput = {
  start: { grade: "R", level: 0, exp: 0 },
  stock: { blue: 59, purple: 39, yellow: 19 },
  strategy: "supply",
};

export function serviceTestOutput(): CertifiedRuntimeOutput {
  const zero = { numerator: "0", denominator: "1" };
  const output: CertifiedOutput = {
    status: "completed",
    current: {
      status: "use_certified", kit: "blue", uses: 2, pieces: 20, optimalActionMask: 1,
      certification: "exact_rational_finite_inventory_v1",
      value: {
        successP: { numerator: "1", denominator: "2" },
        weightedExpectedConsumptionB: zero,
        expectedTotalConsumptionC: zero,
        expectedConsumed: [zero, zero, zero],
        display: { successP: 0.5, weightedExpectedConsumptionB: 0, expectedTotalConsumptionC: 0 },
      },
    },
    waiting: {
      status: "unresolved", horizonDays: 14, recommendedDays: null, rangeBoundary: false,
      bestDayRange: null, value: null, evaluatedDays: [], successImprovementUpperBound: null,
      successProbabilityInterval: null, reason: "synthetic", evidence: [],
    },
    claimNotice: null, refusal: null, pricing: null,
    provenance: {
      solverVersion: "certified-exact-rust-wasm-v1",
      arithmetic: "exact_bigint_ladder_reduced_public_rationals",
      calculationGraph: "repeated_exact_date_expectations_shared_finite_memo",
      requestBudgetMs: 15000, horizonMeaning: "range_only_no_deadline",
      snapshotRevision: "synthetic", snapshotSourceHash: "synthetic",
      objective: "max_P_min_B_min_C_exact_earliest_date",
    },
    diagnostics: {
      elapsedMs: 0, memoEntries: 0, exactTransitions: 0, supportPeakPoints: 0,
      managedPayloadBytes: 0, managedPayloadDefinition: "synthetic",
      unmeasuredMemory: [], wasmMemoryBytes: 0, kernelCalls: 0,
    },
  };
  // The production client is replaced at its validated-output boundary in these unit tests.
  return { ...output, runtimeBinding: {} as CertifiedRuntimeOutput["runtimeBinding"] };
}

export function serviceTestWait(day = 3): StableRuntimeRecommendation {
  const zero = { n: 0n, d: 1n };
  return {
    context: {
      requestId: "synthetic", inputFingerprint: "synthetic", stateFingerprint: "synthetic",
      engineFingerprint: "synthetic", modelFingerprint: "synthetic",
      asOf: "2026-09-30T04:00:00Z", horizonDays: 14,
    },
    policy: {
      version: "experimental-stable-w-selector-v1",
      gainRiskLimit: { numerator: "1", denominator: "20" },
      repeatRiskLimit: { numerator: "1", denominator: "20" },
    },
    // The selector is deliberately not executed by these control tests.
    baseline: {} as StableRuntimeRecommendation["baseline"],
    selection: {
      status: "WAIT", day, probability: zero, selectedW: zero,
      insufficientGainMass: zero, renewedWaitUpperBound: zero,
    },
    guidance: { status: "WAIT", day },
  };
}
