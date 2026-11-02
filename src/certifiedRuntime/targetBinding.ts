import { cmp, fromWire, type WireQ } from "../../shared/certifiedRational.ts";
import { validateTargetValue } from "../certified/target.ts";
import type { CertifiedOutput, CertifiedTargetBudget } from "../certified/types.ts";

function invalid(): never {
  throw new Error("target_evidence_binding_mismatch");
}

/** Checks internal certificate consistency, not the truth of solver-produced probabilities. */
export function assertTargetEvidence(output: CertifiedOutput, budget?: CertifiedTargetBudget) {
  let reserved = 0;
  const reserve = (bytes: number) => {
    reserved += bytes;
    budget?.reserve(bytes);
  };
  try {
    budget?.check();
    validateEvidence(output, () => budget?.check(), reserve);
    budget?.check();
  } finally {
    budget?.release(reserved);
  }
}

function validateEvidence(output: CertifiedOutput, check: () => void, reserve: (bytes: number) => void) {
  const target = output.target;
  if (!target) return;
  const probability = (wire: WireQ) => {
    check();
    if (!wire || typeof wire.numerator !== "string" || typeof wire.denominator !== "string")
      return invalid();
    reserve(128 + 8 * (wire.numerator.length + wire.denominator.length));
    if (!/^[0-9]+$/.test(wire.numerator) || !/^[0-9]+$/.test(wire.denominator) ||
        !/[1-9]/.test(wire.denominator)) return invalid();
    const p = fromWire(wire);
    check();
    if (p.n > p.d) invalid();
    return p;
  };
  if (!Array.isArray(target.probabilities) || target.probabilities.length > target.maxDays + 1)
    invalid();
  if (target.reason !== null && typeof target.reason !== "string") invalid();
  const alpha = probability(target.alpha);
  let previous = -1;
  let prefix = -1;
  let attained: number | null = null;
  let earliest: number | null = null;
  for (const record of target.probabilities) {
    if (!record || !Number.isInteger(record.day) || record.day <= previous ||
        record.day < 0 || record.day > target.maxDays) invalid();
    previous = record.day;
    const p = probability(record.successP);
    if (record.day === 0) {
      if (!output.current || cmp(p, probability(output.current.value.successP))) invalid();
    }
    if (cmp(p, alpha) >= 0 && attained === null) attained = record.day;
    if (record.day === prefix + 1) {
      prefix = record.day;
      if (earliest === null && cmp(p, alpha) >= 0) earliest = record.day;
    }
  }
  if (target.probabilities.length === 0) {
    if (target.minimumDays !== null || target.value !== null ||
        target.completedThroughDay !== null || target.attainedByDay !== null ||
        target.earliestNotRuledOutDay !== null || !target.reason ||
        !["unresolved", "claim_required"].includes(target.status)) invalid();
    if (target.status === "claim_required" && !output.claimNotice) invalid();
    return;
  }
  // The reported H14 prefix may extend beyond the disclosed target range. Only
  // an in-range gap contradicts it; undisclosed future dates are not verified here.
  if (output.claimNotice || prefix < 0 || !Number.isInteger(target.completedThroughDay) ||
      target.completedThroughDay === null || target.completedThroughDay < prefix ||
      target.completedThroughDay > 14 ||
      (prefix < target.maxDays && target.completedThroughDay !== prefix)) invalid();
  if (target.attainedByDay !== attained) invalid();
  if (earliest !== null) {
    if (target.status !== "certified" || target.minimumDays !== earliest ||
        target.earliestNotRuledOutDay !== earliest || target.reason !== null || !target.value)
      invalid();
    validateTargetValue(target.value, check, reserve);
    const record = target.probabilities.find(record => record.day === earliest);
    if (!record || cmp(probability(target.value.successP), probability(record.successP))) invalid();
    if (earliest === 0 && output.current) {
      for (const key of ["weightedExpectedConsumptionB", "expectedTotalConsumptionC"] as const)
        if (cmp(fromWire(target.value[key]), fromWire(output.current.value[key]))) invalid();
      for (const i of [0, 1, 2] as const)
        if (cmp(fromWire(target.value.expectedConsumed[i]), fromWire(output.current.value.expectedConsumed[i])))
          invalid();
    }
  } else {
    if (target.minimumDays !== null || target.value !== null) invalid();
    if (prefix === target.maxDays) {
      if (target.status !== "not_reached_within_limit" || target.reason !== null ||
          target.earliestNotRuledOutDay !== null) invalid();
    } else if (target.status !== "unresolved" || !target.reason ||
        target.earliestNotRuledOutDay !== prefix + 1) invalid();
  }
}
