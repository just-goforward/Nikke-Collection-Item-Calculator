import type {
  DeliveryAggregateRow,
  FailureAggregateRow,
  RejectionAggregateRow,
  SourceObservation,
} from "./types";

const IMMEDIATE_CRITICAL = new Set([
  "wasm_trap",
  "stale_handle",
  "invalid_worker_payload",
  "invalid_worker_response",
  "unknown_rust_status",
  "solve_in_flight",
  "missing_export",
  "wasm_url_missing",
]);

const NON_ERRORS = new Set(["not_attempted", "success"]);

export function failureObservation(row: FailureAggregateRow): SourceObservation {
  const exitChain = [row.min_ef_exit, row.phase2_exit, row.js_exit];
  const errors = exitChain.filter((value) => !NON_ERRORS.has(value));
  const immediate = errors.find((value) => IMMEDIATE_CRITICAL.has(value));
  const errorCode = immediate ?? errors.at(-1) ?? "solver_terminal_failure";
  return {
    sourceKind: "solver_failure",
    identity: rowIdentity(row),
    fingerprintIdentity: {
      source: "solver_failure",
      appRevision: row.app_revision,
      policyVersion: row.policy_version,
      requestedBackend: row.requested_backend,
      exitChain: exitChain.join(">"),
      terminalBackend: row.terminal_backend,
      forecastId: row.forecast_id,
    },
    errorCode,
    immediateCritical: Boolean(immediate),
    alertable: true,
    events: Number(row.events),
    firstSeen: Number(row.first_seen),
    lastSeen: Number(row.last_seen),
    context: {
      appRevision: row.app_revision,
      ingestRevision: row.ingest_revision,
      policyVersion: row.policy_version,
      forecastId: row.forecast_id,
      forecastProfileId: row.forecast_profile_id,
      requestedBackend: row.requested_backend,
      terminalBackend: row.terminal_backend,
      exitChain: exitChain.join(" > "),
      solverVersions: `${row.rust_min_ef_solver_version} / ${row.rust_phase2_solver_version} / ${row.js_phase2_solver_version}`,
      stateBucket: `${row.grade}${row.level}:exp${row.exp_bucket}`,
      stockBuckets: `${row.stock_bucket_blue}/${row.stock_bucket_purple}/${row.stock_bucket_yellow}`,
      client: `${row.device_type}:${row.browser}${row.browser_major}/${row.os}${row.os_major}`,
    },
  };
}

export function rejectionObservation(row: RejectionAggregateRow): SourceObservation {
  return {
    sourceKind: "submission_rejection",
    identity: { ...rowIdentity(row), source: "submission_rejection" },
    fingerprintIdentity: {
      source: "submission_rejection",
      errorCode: row.rejection_code,
      eventKind: row.event_kind,
      recoveryVersion: row.recovery_version,
      policyVersion: row.policy_version,
      appRevision: row.app_revision,
    },
    errorCode: row.rejection_code,
    immediateCritical: true,
    alertable: true,
    events: Number(row.events),
    firstSeen: Number(row.first_seen),
    lastSeen: Number(row.last_seen),
    context: {
      appRevision: row.app_revision,
      eventKind: row.event_kind,
      recoveryVersion: row.recovery_version,
      policyVersion: row.policy_version,
    },
  };
}

export function deliveryObservation(row: DeliveryAggregateRow): SourceObservation {
  const alertable =
    row.age_bucket === "5m_15m" ||
    row.age_bucket === "expired" ||
    row.attempts_bucket === "3_5" ||
    row.attempts_bucket === "6_plus";
  return {
    sourceKind: "delivery_health",
    identity: { ...rowIdentity(row), source: "delivery_health" },
    fingerprintIdentity: {
      source: "delivery_health",
      outcome: row.outcome,
      eventKind: row.event_kind,
      lastFailureClass: row.last_failure_class,
      appRevision: row.app_revision,
    },
    errorCode: `delivery_${row.last_failure_class}`,
    immediateCritical: false,
    alertable,
    events: Number(row.events),
    firstSeen: Number(row.first_seen),
    lastSeen: Number(row.last_seen),
    context: {
      appRevision: row.app_revision,
      outcome: row.outcome,
      eventKind: row.event_kind,
      attempts: row.attempts_bucket,
      age: row.age_bucket,
      lastFailureClass: row.last_failure_class,
    },
  };
}

export function runtimeObservation(input: {
  environment: string;
  deploymentWindow: string;
  errorCode: "worker_runtime_error" | "worker_exceeded_cpu";
  events: number;
  firstSeen: number;
  lastSeen: number;
}): SourceObservation {
  return {
    sourceKind: "worker_runtime",
    identity: {
      source: "worker_runtime",
      environment: input.environment,
      errorCode: input.errorCode,
    },
    fingerprintIdentity: {
      source: "worker_runtime",
      environment: input.environment,
      errorCode: input.errorCode,
    },
    errorCode: input.errorCode,
    immediateCritical: true,
    alertable: true,
    events: input.events,
    firstSeen: input.firstSeen,
    lastSeen: input.lastSeen,
    context: { deploymentWindow: input.deploymentWindow },
  };
}

export function observerIntegrityObservation(input: {
  errorCode: "observer_count_decrease" | "observer_identity_collision" | "observer_invalid_count";
  sourceKind: SourceObservation["sourceKind"];
  rowHash: string;
  now: number;
}): SourceObservation {
  const identity = {
    source: "observer_integrity",
    sourceKind: input.sourceKind,
    rowHash: input.rowHash,
    errorCode: input.errorCode,
  };
  return {
    sourceKind: "observer_integrity",
    identity,
    fingerprintIdentity: identity,
    errorCode: input.errorCode,
    immediateCritical: true,
    alertable: true,
    events: 1,
    firstSeen: input.now,
    lastSeen: input.now,
    context: {
      affectedSource: input.sourceKind,
      rowHashPrefix: input.rowHash.slice(0, 12),
    },
  };
}

export function nextSeverity(immediateCritical: boolean, windowCount: number) {
  return immediateCritical || windowCount >= 3 ? "critical" : "warning";
}

function rowIdentity(row: object) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !["events", "first_seen", "last_seen"].includes(key)),
  ) as Record<string, string | number>;
}
