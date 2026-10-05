import { certifiedSupplyLawPayloadBytes } from "../../shared/certifiedSupplyLaws";
import type { WorkBudget } from "./budget";
import { waitingBase } from "./events";
import type { CertifiedInput, CertifiedOutput } from "./types";
export function createOutput(input: CertifiedInput): CertifiedOutput {
  return {
    status: "refused",
    current: null,
    waiting: waitingBase("unresolved", "current_not_completed"),
    refusal: null,
    claimNotice: null,
    pricing: null,
    provenance: {
      solverVersion: "certified-exact-js-v1",
      arithmetic: "exact_bigint_ladder_reduced_public_rationals",
      calculationGraph: "repeated_exact_date_expectations_shared_finite_memo",
      requestBudgetMs: 15000,
      horizonMeaning: "range_only_no_deadline",
      snapshotRevision: input.snapshot?.revision ?? "",
      snapshotSourceHash: input.snapshot?.sourceHash ?? "",
      objective: "max_P_min_B_min_C_exact_earliest_date",
    },
    diagnostics: {
      elapsedMs: 0,
      memoEntries: 0,
      exactTransitions: 0,
      supportPeakPoints: 0,
      managedPayloadBytes: 0,
      managedPayloadDefinition:
        "owned numerical payload: typed bound pages, BigInt limbs, tuple slots, memo keys, exact support rows; excludes JS engine allocator metadata",
      unmeasuredMemory: [
        "V8 object and Map allocator overhead",
        "V8 compiler/code cache",
        "thread stack",
        "transient supply-law work tables",
        "transient finite arithmetic and recursive frame temporaries",
        "constant game graph arrays",
      ],
      wasmMemoryBytes: 0,
      kernelCalls: 0,
    },
  };
}
export function updateDiagnostics(
  output: CertifiedOutput,
  started: number,
  budget: WorkBudget | null,
): void {
  output.diagnostics.elapsedMs = performance.now() - started;
  if (budget)
    Object.assign(output.diagnostics, {
      memoEntries: budget.memoEntries,
      exactTransitions: budget.exactTransitions,
      supportPeakPoints: budget.supportPeakPoints,
      managedPayloadBytes: Math.max(
        budget.managedPayloadPeakBytes,
        budget.managedPayloadBytes + certifiedSupplyLawPayloadBytes(),
      ),
      kernelCalls: budget.kernelCalls,
    });
}
