import {
  assertCertifiedEngineProfile,
  CERTIFIED_STAGING_ENGINE_PROFILE,
  type CertifiedEngineProfile,
} from "../../shared/certifiedEngineProfile.ts";
import {
  assertCertifiedForecastIdentity,
  type CertifiedForecastIdentity,
  sameCertifiedForecastIdentity,
} from "../../shared/certifiedForecastIdentity.ts";
import type { CertifiedInput, CertifiedOutput, CertifiedTargetBudget } from "../certified/types.ts";
import { targetConfig } from "../certified/target.ts";
import { assertMinimumWaitBinding } from "./minimumWait.ts";
import { assertTargetEvidence } from "./targetBinding.ts";
import { assertCompletedEvidence } from "./completedBinding.ts";
import { riskBinding } from "./riskBinding.ts";
import { liveJsonWorkspace, liveRuntimeRecommendation, type LiveRequestIdentity, type LiveRuntimeRecommendation } from "../certifiedRecommendation/liveRuntime.ts";
import { stableRuntimeRecommendation, type StableRuntimeRecommendation } from "../certifiedRecommendation/stableRuntime.ts";

export type CertifiedRuntimeOutput = CertifiedOutput & {
  riskSummaryBinding?: ReturnType<typeof riskBinding>;
  autoRecommendation?: LiveRuntimeRecommendation;
  stableRecommendation?: StableRuntimeRecommendation;
  runtimeBinding: {
    engineProfile: CertifiedEngineProfile;
    forecastIdentity: CertifiedForecastIdentity;
  };
};

function assertSolverProvenance(output: CertifiedOutput, identity: CertifiedForecastIdentity) {
  if (
    output.provenance.snapshotRevision !== identity.snapshotRevision ||
    output.provenance.snapshotSourceHash !== identity.sourceHash
  ) {
    throw new Error("Certified output provenance does not match the submitted snapshot.");
  }
  if (output.minimumWait !== undefined)
    assertMinimumWaitBinding(output.minimumWait, output.current);
}

/** Request binding only: this does not prove the solver's target evidence. */
function assertTargetRequestBinding(output: CertifiedOutput, input?: CertifiedInput, budget?: CertifiedTargetBudget) {
  const requested = input === undefined ? undefined : targetConfig(input);
  if (input === undefined || requested === undefined) {
    if (output.target !== undefined)
      throw new Error("Certified output contains an unrequested target.");
    return;
  }
  if (output.target === undefined)
    throw new Error("Certified output target is missing.");
  const echoed = targetConfig({ ...input, target: output.target });
  if (
    !echoed ||
    echoed.version !== requested.version ||
    echoed.alpha.numerator !== requested.alpha.numerator ||
    echoed.alpha.denominator !== requested.alpha.denominator ||
    output.target.maxDays !== requested.maxDays
  )
    throw new Error("Certified output target does not match the submitted input.");
  assertTargetEvidence(output, budget);
}

/** Only the trusted worker binds standalone solver content after verifying provenance. */
export function bindCertifiedOutput(
  output: CertifiedOutput,
  identity: CertifiedForecastIdentity,
  input?: CertifiedInput,
  budget?: CertifiedTargetBudget,
  mode: "current" | "result" = "result",
  request?: LiveRequestIdentity,
): CertifiedRuntimeOutput {
  assertSolverProvenance(output, identity);
  assertTargetRequestBinding(output, input, budget);
  assertCompletedEvidence(output, input, budget, mode);
  const autoRecommendation = input?.autoRecommendation === true && mode === "result" && output.completedEvidence !== undefined
    ? (() => {
      if (!budget || !request) throw new Error("recommendation_request_binding_missing");
      return liveRuntimeRecommendation(input, output, request, CERTIFIED_STAGING_ENGINE_PROFILE, identity, budget);
    })() : undefined;
  const runtimeBinding = Object.freeze({
    engineProfile: Object.freeze(structuredClone(CERTIFIED_STAGING_ENGINE_PROFILE)),
    forecastIdentity: Object.freeze(assertCertifiedForecastIdentity(identity)),
  });
  const risk = riskBinding(output, input, budget, mode, request, CERTIFIED_STAGING_ENGINE_PROFILE, identity);
  const stableRecommendation = input?.stableRecommendation !== undefined && mode === "result"
    ? (() => {
      if (!budget || !request) throw new Error("stable_recommendation_binding_missing");
      return stableRuntimeRecommendation(input, output, request, CERTIFIED_STAGING_ENGINE_PROFILE, identity, budget);
    })() : undefined;
  return {
    ...output,
    ...(risk !== undefined ? { riskSummaryBinding: risk } : {}),
    ...(autoRecommendation ? { autoRecommendation } : {}),
    ...(stableRecommendation ? { stableRecommendation } : {}),
    runtimeBinding,
  };
}

/** Compare the recomputed recommendation without coercing primitives or dropping extra fields. */
function sameRecommendationValue(actual: unknown, expected: unknown, check: () => void): boolean {
  check();
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== "object" || actual === null ||
    typeof expected !== "object" || expected === null) return false;
  if (Array.isArray(actual) !== Array.isArray(expected) ||
    Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;
  if (Array.isArray(actual) && Array.isArray(expected) && actual.length !== expected.length)
    return false;
  const keys = Reflect.ownKeys(expected);
  if (Reflect.ownKeys(actual).length !== keys.length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(actual, key) ||
      !sameRecommendationValue(Reflect.get(actual, key), Reflect.get(expected, key), check))
      return false;
  }
  return true;
}

/** The output body and envelope must independently carry the complete same binding. */
export function assertCertifiedOutputBinding(
  output: CertifiedOutput,
  identity: CertifiedForecastIdentity,
  input?: CertifiedInput,
  budget?: CertifiedTargetBudget,
  mode: "current" | "result" = "result",
  request?: LiveRequestIdentity,
) {
  const binding = Reflect.get(output, "runtimeBinding");
  if (!binding || typeof binding !== "object")
    throw new Error("Certified output runtime binding is missing.");
  assertCertifiedEngineProfile(binding.engineProfile);
  if (
    !sameCertifiedForecastIdentity(
      assertCertifiedForecastIdentity(binding.forecastIdentity),
      identity,
    )
  )
    throw new Error(
      "Certified output body forecast identity does not match the submitted snapshot.",
    );
  assertSolverProvenance(output, identity);
  assertTargetRequestBinding(output, input, budget);
  assertCompletedEvidence(output, input, budget, mode);
  const actual = (output as CertifiedRuntimeOutput).autoRecommendation;
  const actualRisk = (output as CertifiedRuntimeOutput).riskSummaryBinding;
  const actualStable = (output as CertifiedRuntimeOutput).stableRecommendation;
  const riskWorkspace = output.riskSummaries !== undefined || actualRisk !== undefined
    ? 2 * liveJsonWorkspace({ actualRisk, input, request, identity, output }) : 0;
  if (output.riskSummaries !== undefined || actualRisk !== undefined || input?.riskSummary === true) {
  try {
    budget?.reserve(riskWorkspace);
    const expectedRisk = riskBinding(output, input, budget, mode, request, binding.engineProfile, identity, "verification");
    if (!sameRecommendationValue(actualRisk, expectedRisk, () => budget?.check()))
      throw new Error("risk_summary_binding_mismatch");
  } finally {
    budget?.release(riskWorkspace);
  }
  }
  if (input?.stableRecommendation !== undefined && mode === "result") {
    if (!budget || !request || !actualStable) throw new Error("stable_recommendation_binding_missing");
    const workspace = 2 * liveJsonWorkspace({ actualStable, input, request, identity });
    try {
      budget.reserve(workspace);
      const expected = stableRuntimeRecommendation(input, output, request, binding.engineProfile, identity, budget, "verification");
      if (!sameRecommendationValue(actualStable, expected, () => budget.check()))
        throw new Error("stable_recommendation_binding_mismatch");
    } finally {
      budget.release(workspace);
    }
  } else if (actualStable !== undefined) throw new Error("unrequested_stable_recommendation");
  if (input?.autoRecommendation === true && mode === "result" && output.completedEvidence !== undefined) {
    if (!budget || !request || !actual) throw new Error("recommendation_request_binding_missing");
    const workspace = 2 * (liveJsonWorkspace(actual) + liveJsonWorkspace({ input, identity, request }));
    try {
      budget.reserve(workspace);
      const expected = liveRuntimeRecommendation(input, output, request, binding.engineProfile, identity, budget);
      budget.check();
      // Key arrays and recursive comparison remain inside the admitted workspace.
      if (!sameRecommendationValue(actual, expected, () => budget.check()))
        throw new Error("recommendation_binding_mismatch");
      budget.check();
    } finally {
      budget.release(workspace);
    }
  } else if (actual !== undefined) throw new Error("unrequested_recommendation");
}
