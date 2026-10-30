import { cmp, fromWire, q, sub, toWire, type Q, type WireQ } from "../../shared/certifiedRational";
import { decodeRiskSummaries } from "../certified/riskSummary";
import type { CertifiedRiskSummaries, CompletedDate } from "../certified/types";
import { RecommendationEvidenceError, validateRecommendationEvidence, type RecommendationContext, type RecommendationEvidence } from "./evidence";
import { RECOMMENDATION_DELTA, selectRecommendation, type RecommendationResult } from "./policy";

export interface StableRiskPolicy {
  readonly version: "experimental-stable-w-selector-v1";
  readonly gainRiskLimit: WireQ;
  readonly repeatRiskLimit: WireQ;
}

/** Internal explicit presets only; never defaults or user-selected thresholds. */
export function validateStableRiskPolicy(settings: StableRiskPolicy): StableRiskPolicy {
  const fail = (): never => { throw new RecommendationEvidenceError("invalid_input", "Invalid stable risk policy."); };
  const ownKeys = (value: unknown, expected: readonly string[]): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const keys = Reflect.ownKeys(value as object);
    if (keys.length !== expected.length || keys.some(key => typeof key !== "string" || !expected.includes(key))) fail();
  };
  ownKeys(settings, ["version", "gainRiskLimit", "repeatRiskLimit"]);
  if (settings.version !== "experimental-stable-w-selector-v1") fail();
  const cap = (wire: WireQ): WireQ => {
    ownKeys(wire, ["numerator", "denominator"]);
    if (typeof wire.numerator !== "string" || typeof wire.denominator !== "string" ||
      !/^\d+$/.test(wire.numerator) || !/^[1-9]\d*$/.test(wire.denominator)) fail();
    const value = fromWire(wire);
    if (cmp(value, q(1, 20)) !== 0 && cmp(value, q(1, 10)) !== 0) fail();
    return toWire(value);
  };
  return { version: settings.version, gainRiskLimit: cap(settings.gainRiskLimit), repeatRiskLimit: cap(settings.repeatRiskLimit) };
}

export type StableResult =
  | { readonly status: "INCOMPLETE"; readonly reason: "missing-coverage" | "risk-summary-unavailable" }
  | { readonly status: "NOW"; readonly day: 0 }
  | { readonly status: "WAIT"; readonly day: number; readonly probability: Q; readonly selectedW: Q;
      readonly insufficientGainMass: Q; readonly renewedWaitUpperBound: Q }
  | { readonly status: "STABLE_WAIT_UNCONFIRMED"; readonly reasons: readonly ("risk-threshold" | "upper-uncertified")[] };

export interface StableRecommendationResult {
  readonly context: RecommendationContext;
  readonly policy: StableRiskPolicy;
  readonly baseline: RecommendationResult;
  readonly stable: StableResult;
}

/**
 * Trusted in-process contract: the caller's existing request binding MUST authenticate
 * riskSummaries and enforce its evidence budget before calling. The wire envelope
 * has no request identity; consistency decoding here is not authentication.
 * No general F certificate is supported.
 */
export function selectStableRecommendation(
  expectedContext: RecommendationContext,
  evidence: RecommendationEvidence,
  riskSummaries: CertifiedRiskSummaries | undefined,
  settings: StableRiskPolicy,
): StableRecommendationResult {
  const fail = (message: string): never => { throw new RecommendationEvidenceError("corrupt_evidence", message); };
  const policy = validateStableRiskPolicy(settings);
  const gain = fromWire(policy.gainRiskLimit);
  const repeat = fromWire(policy.repeatRiskLimit);
  const { probabilities } = validateRecommendationEvidence(expectedContext, evidence);
  if (evidence.upperAttainment != null) fail("General F upper attainment is unsupported.");
  const baseline = selectRecommendation(expectedContext, evidence);
  if (riskSummaries !== undefined) {
    // The decoder only consumes day/value.successP. No synthetic solver results
    // are used as evidence: each successP is the validated actual expectation.
    const completed = [...probabilities].map(([day, probability]) => ({
      day, value: { successP: toWire(probability) },
    })) as CompletedDate[];
    decodeRiskSummaries(riskSummaries, true, completed, {
      check() {}, reserve() {}, release() {},
    });
    // Mean one of a [0,1] variable implies success probability one in every
    // positive-mass outcome. Positive W therefore certifies both risk caps.
    const p0 = probabilities.get(0);
    for (const record of riskSummaries.records) {
      if (cmp(probabilities.get(record.day)!, q(1)) !== 0) continue;
      if (cmp(fromWire(record.renewedWaitUpperBound), q(0)) !== 0 ||
        cmp(fromWire(record.noFurtherWaitCertifiedMass), q(1)) !== 0)
        fail("Mean-one risk summary must certify no further wait.");
      if (p0 !== undefined) {
        const benefit = sub(sub(q(1), p0), q(record.day, 400));
        const insufficient = cmp(benefit, RECOMMENDATION_DELTA) <= 0 ? q(1) : q(0);
        if (cmp(fromWire(record.insufficientGainMass), insufficient) !== 0)
          fail("Mean-one risk summary contradicts exact benefit.");
      }
    }
  }
  const finish = (stable: StableResult): StableRecommendationResult => ({
    context: { ...expectedContext },
    policy,
    baseline, stable,
  });
  if (baseline.status === "INCOMPLETE") return finish({ status: "INCOMPLETE", reason: "missing-coverage" });
  if (baseline.status === "NOW") return finish({ status: "NOW", day: 0 });
  if (riskSummaries === undefined) return finish({ status: "INCOMPLETE", reason: "risk-summary-unavailable" });
  let best: Extract<StableResult, { status: "WAIT" }> | undefined;
  const reasons = new Set<"risk-threshold" | "upper-uncertified">();
  for (const record of riskSummaries.records) {
    const probability = probabilities.get(record.day)!;
    const w = sub(sub(probability, probabilities.get(0)!), q(record.day, 400));
    if (record.day === 0 || cmp(w, RECOMMENDATION_DELTA) <= 0) continue;
    const gainFails = cmp(fromWire(record.insufficientGainMass), gain) > 0;
    const repeatFails = cmp(fromWire(record.renewedWaitUpperBound), repeat) > 0;
    if (gainFails) reasons.add("risk-threshold");
    if (repeatFails) reasons.add("upper-uncertified");
    if (!gainFails && !repeatFails && (!best || cmp(w, best.selectedW) > 0))
      best = { status: "WAIT", day: record.day, probability, selectedW: w,
        insufficientGainMass: fromWire(record.insufficientGainMass),
        renewedWaitUpperBound: fromWire(record.renewedWaitUpperBound) };
  }
  // For contiguous P=1 prefixes, later W is strictly smaller than attainment
  // (P<=1 and increasing day cost), and attainment is itself risk-qualified.
  return finish(best ?? { status: "STABLE_WAIT_UNCONFIRMED", reasons: [...reasons] });
}
