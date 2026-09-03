export const SOLVER_RECOVERY_VERSIONS = [1, 2] as const;
export type SolverRecoveryVersion = (typeof SOLVER_RECOVERY_VERSIONS)[number];

// Keep the client on v1 until the production statistics Worker advertises v2 support.
export const SOLVER_RECOVERY_EMIT_VERSION: SolverRecoveryVersion = 1;

export const SOLVER_RECOVERY_POLICY_VERSIONS = ["ladder_v1", "ladder_v2"] as const;
export type SolverRecoveryPolicyVersion = (typeof SOLVER_RECOVERY_POLICY_VERSIONS)[number];
export const SOLVER_RECOVERY_EMIT_POLICY_VERSION: SolverRecoveryPolicyVersion = "ladder_v2";

export const SOLVER_RECOVERY_RUST_MIN_EF_VERSION = "phase3_rust_min_ef";
export const SOLVER_RECOVERY_RUST_PHASE2_VERSION =
  "phase2_availability_h075_tau0_p3_rust_segmented_v1";
export const SOLVER_RECOVERY_JS_PHASE2_VERSION = "phase2_availability_h075_tau0_p3";

export const SOLVER_RECOVERY_SOLVER_VERSIONS = {
  rustMinEf: SOLVER_RECOVERY_RUST_MIN_EF_VERSION,
  rustPhase2: SOLVER_RECOVERY_RUST_PHASE2_VERSION,
  jsPhase2: SOLVER_RECOVERY_JS_PHASE2_VERSION,
} as const;

export const SOLVER_RECOVERY_APP_REVISION_PATTERN = /^(?:[0-9a-f]{40}|local|unknown)$/;
export const LEGACY_RECOVERY_REVISION = "legacy-unversioned" as const;
export const LEGACY_RECOVERY_SOLVER_VERSIONS = {
  rustMinEf: LEGACY_RECOVERY_REVISION,
  rustPhase2: LEGACY_RECOVERY_REVISION,
  jsPhase2: LEGACY_RECOVERY_REVISION,
} as const;

export const DELIVERY_ATTEMPT_BUCKETS = ["1", "2", "3_5", "6_plus"] as const;
export type DeliveryAttemptBucket = (typeof DELIVERY_ATTEMPT_BUCKETS)[number];

export const DELIVERY_AGE_BUCKETS = ["lt_30s", "30s_2m", "2m_5m", "5m_15m", "expired"] as const;
export type DeliveryAgeBucket = (typeof DELIVERY_AGE_BUCKETS)[number];

export const DELIVERY_FAILURE_CLASSES = [
  "network",
  "timeout",
  "rate_limited",
  "server_error",
  "contract_rejected",
  "turnstile_rejected",
  "origin_rejected",
  "quota_disabled",
  "unknown",
] as const;
export type DeliveryFailureClass = (typeof DELIVERY_FAILURE_CLASSES)[number];

export const STATS_DELIVERY_EVENT_KINDS = [
  "kit_result",
  "runtime_invariant",
  "solver_diagnostic",
  "solver_recovery",
] as const;
export type StatsDeliveryEventKind = (typeof STATS_DELIVERY_EVENT_KINDS)[number];

// Enable only after the production statistics Worker advertises the sidecar contract.
export const STATS_DELIVERY_HEALTH_EMIT_ENABLED = false;

export type StatsDeliveryHealth = {
  outcome: "retried_success" | "dropped_nonretryable";
  eventKind: StatsDeliveryEventKind;
  appRevision: string;
  attempts: DeliveryAttemptBucket;
  age: DeliveryAgeBucket;
  lastFailureClass: DeliveryFailureClass;
  events: number;
};

export function bucketDeliveryAttempts(value: number): DeliveryAttemptBucket {
  if (value <= 1) return "1";
  if (value === 2) return "2";
  if (value <= 5) return "3_5";
  return "6_plus";
}

export function bucketDeliveryAge(ageMs: number): DeliveryAgeBucket {
  if (ageMs < 30_000) return "lt_30s";
  if (ageMs < 120_000) return "30s_2m";
  if (ageMs < 300_000) return "2m_5m";
  if (ageMs < 900_000) return "5m_15m";
  return "expired";
}
