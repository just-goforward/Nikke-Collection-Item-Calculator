import type { CertifiedValue } from "../src/certified/types.ts";
import { cmp, compareValue, fromWire } from "./certified-staging-oracle.ts";
import type { PublicPathRelaxationResult } from "./certified-staging-oracle-public-path-relaxation.ts";

type EndpointWitness = { beforeValue: CertifiedValue; afterValue: CertifiedValue };
type Wire = Parameters<typeof fromWire>[0];
type Decoded = ReturnType<typeof fromWire>;
// Native .every may skip holes or visit indices beyond the public tuple.
// fromWire's first property read throws on undefined, so the decoder boundary
// accepts missing coordinates without claiming they yield a decoded value.
const decodeConsumed = fromWire as {
  (value: undefined): never;
  (value: Wire): Decoded;
  (value: Wire | undefined): Decoded;
};
function endpointParity(
  value: PublicPathRelaxationResult["before"],
  fits: boolean,
  saved: CertifiedValue,
): boolean {
  return (
    fits &&
    value !== null &&
    compareValue(value, {
      P: fromWire(saved.successP),
      B: fromWire(saved.weightedExpectedConsumptionB),
      C: fromWire(saved.expectedTotalConsumptionC),
    }) === 0 &&
    value.consumed.every(
      (consumed, color) => cmp(consumed, decodeConsumed(saved.expectedConsumed[color])) === 0,
    )
  );
}
export function checkPublicRelaxationProof(
  result: PublicPathRelaxationResult,
  witness: EndpointWitness,
) {
  // Resource and unsupported statuses are authoritative, even when the helper
  // preserves exact endpoint fields calculated before its final budget check.
  if (result.status === "NOTRUN" || result.status === "UNKNOWN") {
    return {
      status: result.status,
      reason: result.reason,
      beforeParity: false,
      afterParity: false,
    };
  }
  const beforeParity = endpointParity(result.before, result.beforeFits, witness.beforeValue);
  const afterParity = endpointParity(result.after, result.afterFits, witness.afterValue);
  if ((result.beforeFits && !beforeParity) || (result.afterFits && !afterParity)) {
    return {
      status: "FAIL",
      reason: "exact_feasible_relaxation_endpoint_numeric_mismatch",
      beforeParity,
      afterParity,
    };
  }
  if (beforeParity && afterParity && result.strictOrder === 1) {
    return {
      status: "PASS_ENDPOINT_PARITY",
      reason: "both_selected_relaxed_policies_fit_all12_fields_equal_and_strict",
      beforeParity,
      afterParity,
    };
  }
  if (afterParity && result.strictOrder === 1) {
    return {
      status: "PASS_N_ONLY",
      reason: "before_relaxation_upper_bound_strictly_below_feasible_exact_after",
      beforeParity,
      afterParity,
    };
  }
  return {
    status: "UNKNOWN",
    reason: "selected_relaxed_policy_does_not_prove_strict_finite_improvement",
    beforeParity,
    afterParity,
  };
}
