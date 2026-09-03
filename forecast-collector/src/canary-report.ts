import {
  FORECAST_CANARY_POLICY_ID,
  type RuntimeEvaluation,
} from "../../shared/forecastCanaryRuntime";

export const CANARY_WINDOW_MODE = "fixed_8_hours" as const;
export const CANARY_MINIMUM_DELIVERY_RATE = 0.99;
export const CANARY_MINIMUM_COMPLETION_RATE = 0.99;

export type CanaryGateResult = {
  status: "passed" | "failed" | "incomplete";
  failureCodes: string[];
};

type CanaryQuotaResult = {
  valid: boolean;
  errorCode: string | null;
  policy: { passed: boolean; failureCodes: string[] } | null;
};

type DecisionInput = {
  eligible: boolean;
  collectorPassed: boolean;
  dispatcherPassed: boolean;
  routerPassed: boolean;
  earlyFailureReasons: string[];
  invariants: Record<string, number> & { totalInvalid: number };
  quota: CanaryQuotaResult;
  runtime: RuntimeEvaluation;
};

export function evaluateCanaryDecision(input: DecisionInput) {
  const functionalFailures = functionalFailureCodes(input);
  const functional = gateResult(
    functionalFailures.length > 0 ? "failed" : input.eligible ? "passed" : "incomplete",
    functionalFailures,
  );
  const integrityFailures = invariantFailureCodes(input.invariants);
  const integrity = gateResult(
    integrityFailures.length > 0 ? "failed" : "passed",
    integrityFailures,
  );
  const quota = quotaGate(input.quota);
  const runtimeSafety = runtimeGate(input.runtime);
  const evidenceErrors = [
    !input.quota.valid ? input.quota.errorCode : null,
    ...input.runtime.evidence.errors,
  ].filter((value): value is string => value !== null);
  const evidence = {
    status: evidenceErrors.length > 0 ? ("incomplete" as const) : ("valid" as const),
    errors: evidenceErrors,
  };
  const gates = { functional, integrity, quota, runtimeSafety };
  const candidateHardFailures = hardFailureCodes(gates, input.runtime.performance.regressionCodes);
  const earlyHardFailures = [...input.earlyFailureReasons];
  const incomplete =
    evidence.status === "incomplete" ||
    Object.values(gates).some((gate) => gate.status === "incomplete");
  const hardFailures =
    earlyHardFailures.length > 0 ? earlyHardFailures : incomplete ? [] : candidateHardFailures;
  const warnings = [
    ...input.runtime.performance.warnings,
    ...(incomplete ? candidateHardFailures.map((code) => `unconfirmed:${code}`) : []),
  ];
  return {
    ...gates,
    evidence,
    certification: {
      status: certificationStatus(
        hardFailures,
        warnings,
        evidence.status,
        gates,
        input.runtime,
        earlyHardFailures.length > 0,
      ),
      hardFailures,
      warnings,
    },
  };
}

function gateResult(status: CanaryGateResult["status"], failureCodes: string[]): CanaryGateResult {
  return { status, failureCodes };
}

export function missingCanaryReport(
  deploymentSha: string,
  environment: "staging" | "production",
  nowMs: number,
  canaryId: string | null,
) {
  return {
    version: 9,
    policyId: FORECAST_CANARY_POLICY_ID,
    canaryId,
    deploymentSha,
    environment,
    pollMode: "missing",
    acceptance: {
      windowMode: CANARY_WINDOW_MODE,
      windowHours: null,
      minimumDeliveryRate: CANARY_MINIMUM_DELIVERY_RATE,
      minimumCompletionRate: CANARY_MINIMUM_COMPLETION_RATE,
      maximumMissingSlots: 1,
    },
    window: {
      startedAt: null,
      endsAt: null,
      observedUntil: new Date(nowMs).toISOString(),
      eligible: false,
      earlyFailure: false,
      earlyFailureReasons: ["canary_deployment_missing"],
    },
    collector: emptyInvocationSummary(),
    dispatcher: {
      ...emptyInvocationSummary(),
      duplicateDispatches: 0,
      duplicateRuns: 0,
      invalidStates: 0,
      smokeCount: 0,
      invalidSmoke: 0,
      passed: false,
    },
    router: {
      routerTestCount: 0,
      duplicateInteractions: 0,
      maxInitialResponseMs: 0,
      failedAuthorizationSmoke: 0,
      passed: false,
    },
    quotaEvidence: {
      valid: false,
      errorCode: "canary_run_missing",
      evidence: null,
      evidenceHash: null,
      initialEvidenceHash: null,
      freshnessMinutes: null,
      policy: null,
      accountRuntime: null,
    },
    invariants: emptyInvariants(),
    identity: {
      canaryId,
      deploymentSha,
      collectorScriptVersion: null,
      dispatcherScriptVersion: null,
      startedAt: null,
      endedAt: null,
    },
    evidence: { status: "incomplete", errors: ["canary_run_missing"] },
    functional: gateResult("incomplete", []),
    integrity: gateResult("passed", []),
    quota: gateResult("incomplete", []),
    runtimeSafety: gateResult("incomplete", []),
    performance: {
      status: "baseline_bootstrap",
      baselineId: null,
      warnings: ["performance_evidence_incomplete"],
      regressionCodes: [],
      sampleHash: null,
      collector: null,
      dispatcher: null,
    },
    certification: {
      status: "incomplete",
      hardFailures: [],
      warnings: ["performance_evidence_incomplete"],
    },
  };
}

function functionalFailureCodes(input: DecisionInput) {
  return [
    ...input.earlyFailureReasons,
    input.eligible && !input.collectorPassed ? "collector_functional_gate_failed" : null,
    input.eligible && !input.dispatcherPassed ? "dispatcher_functional_gate_failed" : null,
    input.eligible && !input.routerPassed ? "router_functional_gate_failed" : null,
  ].filter((value): value is string => value !== null);
}

function invariantFailureCodes(invariants: DecisionInput["invariants"]) {
  return Object.entries(invariants)
    .filter(([key, count]) => key !== "totalInvalid" && count > 0)
    .map(([key]) => `integrity:${key}`);
}

function quotaGate(quota: CanaryQuotaResult) {
  if (!quota.valid || !quota.policy) return gateResult("incomplete", []);
  return gateResult(quota.policy.passed ? "passed" : "failed", quota.policy.failureCodes);
}

function runtimeGate(runtime: RuntimeEvaluation) {
  if (runtime.runtimeSafety.failureCodes.length > 0) {
    return gateResult("failed", runtime.runtimeSafety.failureCodes);
  }
  return gateResult(runtime.runtimeSafety.status === "incomplete" ? "incomplete" : "passed", []);
}

function hardFailureCodes(gates: Record<string, CanaryGateResult>, regressionCodes: string[]) {
  return [
    ...Object.entries(gates).flatMap(([name, gate]) => failedGateCodes(name, gate)),
    ...regressionCodes,
  ];
}

function failedGateCodes(name: string, gate: CanaryGateResult) {
  if (gate.status !== "failed") return [];
  return gate.failureCodes.length > 0 ? gate.failureCodes : [`${name}_gate_failed`];
}

function certificationStatus(
  hardFailures: string[],
  warnings: string[],
  evidenceStatus: "valid" | "incomplete",
  gates: Record<string, CanaryGateResult>,
  runtime: RuntimeEvaluation,
  provenEarlyFailure: boolean,
) {
  if (provenEarlyFailure) return "failed" as const;
  if (
    evidenceStatus === "incomplete" ||
    Object.values(gates).some((gate) => gate.status === "incomplete")
  ) {
    return "incomplete" as const;
  }
  if (hardFailures.length > 0) return "failed" as const;
  if (warnings.length > 0 || runtime.performance.status === "baseline_bootstrap") {
    return "passed_with_warning" as const;
  }
  return "passed" as const;
}

function emptyInvocationSummary() {
  return {
    expectedSlots: 0,
    observedSlots: 0,
    missingSlots: 0,
    deliveryRate: 0,
    completed: 0,
    failure: 0,
    abandoned: 0,
    completionRate: 0,
    abandonedRate: 0,
    missingRate: 0,
    duplicateInvocations: 0,
    unexpectedInvocations: 0,
    lateInvocations: 0,
    partialSchemaRejections: 0,
    latestStatus: "missing",
  };
}

function emptyInvariants() {
  return {
    queue: 0,
    cursors: 0,
    candidates: 0,
    watermarks: 0,
    reviews: 0,
    manualReviewCoverage: 0,
    callbackStateConflicts: 0,
    unsentCriticalAlerts: 0,
    totalInvalid: 0,
  };
}
