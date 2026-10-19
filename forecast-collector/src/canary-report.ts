import {
  FORECAST_CANARY_POLICY_ID,
  type RuntimeEvaluation,
} from "../../shared/forecastCanaryRuntime";
import { rotationBoard } from "./collection-schedule";

export function rotationCanaryIdentityMatches(id: string, scheduledAt: string) {
  const time = Date.parse(scheduledAt);
  const version2 = id.endsWith(":v2");
  const legacySlot = Math.floor(time / 180_000) % 3;
  const board = version2
    ? rotationBoard(time)
    : legacySlot === 0
      ? 48
      : legacySlot === 1
        ? 56
        : null;
  const prefix = board === null ? "rotation-ingestion" : `rotation-board-${board}`;
  return id === `${prefix}:${time}${version2 ? ":v2" : ""}`;
}

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
  earlyFailureReasons: string[];
  invariants: Record<string, number> & { totalInvalid: number };
  quota: CanaryQuotaResult;
  runtime: RuntimeEvaluation;
} & (
  | { collectorPassed: boolean; dispatcherPassed: boolean; routerPassed: boolean }
  | { monitorProgress: { valid: boolean; failureCodes: string[] } }
);

export function evaluateCanaryDecision(input: DecisionInput) {
  const functionalFailures = functionalFailureCodes(input);
  let functionalStatus: CanaryGateResult["status"] = "failed";
  if (functionalFailures.length === 0) {
    functionalStatus = input.eligible ? "passed" : "incomplete";
  }
  const functional = gateResult(functionalStatus, functionalFailures);
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
    ...("monitorProgress" in input ? functionalFailures : []),
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
  let hardFailures = candidateHardFailures;
  if (earlyHardFailures.length > 0) {
    hardFailures = earlyHardFailures;
  } else if (incomplete) {
    hardFailures = [];
  }
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
    version: 11,
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
    monitorProgress: {
      valid: false,
      identityBinding: "telemetry-only",
      observedAt: new Date(nowMs).toISOString(),
      failureCodes: ["canary_run_missing"],
      streams: [],
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
    invariants: { candidates: 0, totalInvalid: 0 },
    identity: {
      canaryId,
      deploymentSha,
      collectorScriptVersion: null,
      dispatcherScriptVersion: null,
      collectorScriptVersionId: null,
      dispatcherScriptVersionId: null,
      startedAt: null,
      endedAt: null,
    },
    evidence: { status: "incomplete", errors: ["canary_run_missing"] },
    functional: gateResult("incomplete", []),
    integrity: gateResult("incomplete", []),
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
  if ("monitorProgress" in input) {
    const { valid, failureCodes } = input.monitorProgress;
    return valid && failureCodes.length === 0
      ? []
      : failureCodes.length
        ? failureCodes
        : ["v2_monitor_evidence_missing"];
  }
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
  // Account GraphQL runtime summaries also contain HTTP/non-canary traffic.
  // Scheduled runtime safety is decided by independently version-bound telemetry.
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
