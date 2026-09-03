export const FORECAST_CANARY_POLICY_ID = "forecast-canary-v10-live-contract-v1" as const;
export const FORECAST_RUNTIME_TELEMETRY_SOURCE =
  "cloudflare-workers-observability-scheduled-v2" as const;

export const FORECAST_RUNTIME_WORKERS = {
  collector: {
    scriptName: "collection-kit-forecast-collector-staging",
    configuredLimitMs: 50,
  },
  dispatcher: {
    scriptName: "collection-kit-forecast-dispatcher-staging",
    configuredLimitMs: 25,
  },
} as const;

export type ForecastRuntimeComponent = keyof typeof FORECAST_RUNTIME_WORKERS;

export type ForecastRuntimeSample = {
  slot: string;
  requestIdHash: string;
  scriptVersionId: string | null;
  scriptVersionTag: string | null;
  identitySource: "tag" | "version_id" | "marker";
  eventType: "scheduled";
  cpuTimeMs: number;
  outcome: string;
};

export type ForecastRuntimeTelemetryEvidence = {
  version: 2;
  source: typeof FORECAST_RUNTIME_TELEMETRY_SOURCE;
  canaryId: string;
  deploymentSha: string;
  collectorScriptVersion: string;
  dispatcherScriptVersion: string;
  collectorScriptVersionId: string;
  dispatcherScriptVersionId: string;
  startedAt: string;
  endedAt: string;
  observedAt: string;
  collectionErrors?: string[];
  workers: Array<{
    component: ForecastRuntimeComponent;
    scriptName: string;
    configuredLimitMs: number;
    headSamplingRate: 1;
    samples: ForecastRuntimeSample[];
  }>;
};

export type CpuDistribution = {
  samples: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

export type CpuPerformanceBaseline = {
  id: string;
  collector: CpuBaselineWorker;
  dispatcher: CpuBaselineWorker;
};

type CpuBaselineWorker = {
  full: Pick<CpuDistribution, "averageMs" | "p95Ms">;
  firstHalf: Pick<CpuDistribution, "averageMs" | "p95Ms">;
  secondHalf: Pick<CpuDistribution, "averageMs" | "p95Ms">;
};

export type RuntimeEvaluation = {
  evidence: {
    status: "valid" | "incomplete";
    errors: string[];
  };
  runtimeSafety: {
    status: "passed" | "failed" | "incomplete";
    failureCodes: string[];
  };
  performance: {
    status: "pass" | "warning" | "regression" | "baseline_bootstrap";
    baselineId: string | null;
    warnings: string[];
    regressionCodes: string[];
    collector: CpuPerformanceEvidence;
    dispatcher: CpuPerformanceEvidence;
  };
};

export type CpuPerformanceEvidence = {
  scriptName: string;
  configuredLimitMs: number;
  expectedSlots: number;
  d1ObservedSlots: number;
  telemetryObservedSlots: number;
  missingTelemetrySlots: number;
  coverage: number;
  exceededCpu: number;
  unsuccessfulOutcomes: number;
  duplicateSlots: number;
  unmatchedTelemetrySlots: number;
  markerOnlyIdentities: number;
  versionIdOnlyIdentities: number;
  full: CpuDistribution;
  firstHalf: CpuDistribution;
  secondHalf: CpuDistribution;
  p99LimitRatio: number;
};

type EvaluationInput = {
  telemetry: unknown;
  canaryId: string;
  deploymentSha: string;
  collectorScriptVersion: string;
  dispatcherScriptVersion: string;
  collectorScriptVersionId: string;
  dispatcherScriptVersionId: string;
  startedAt: string;
  endedAt: string;
  collectorExpectedSlots: string[];
  dispatcherExpectedSlots: string[];
  collectorD1Slots: string[];
  dispatcherD1Slots: string[];
  baseline?: unknown;
};

type WorkerEvaluation = {
  summary: CpuPerformanceEvidence;
  hardFailures: string[];
  evidenceErrors: string[];
  warnings: string[];
};

type WorkerSampleInspection = {
  slotCounts: Map<string, number>;
  duplicateRequests: number;
  unsuccessfulOutcomes: number;
  exceededCpu: number;
  deploymentMismatches: number;
  markerOnlyIdentities: number;
  versionIdOnlyIdentities: number;
  invalidSamples: number;
};

export function evaluateForecastRuntimeTelemetry(input: EvaluationInput): RuntimeEvaluation {
  const parsed = parseEvaluationInput(input);
  if ("error" in parsed) return incompleteRuntime(parsed.error);
  const identityErrors = runtimeIdentityErrors(parsed.telemetry, input);
  const workers = workerMap(parsed.telemetry);
  const missing = missingWorkerErrors(workers);
  if (identityErrors.length > 0 || missing.length > 0) {
    return incompleteRuntime([...identityErrors, ...missing]);
  }
  const collectorTelemetry = workers.get("collector");
  const dispatcherTelemetry = workers.get("dispatcher");
  if (!collectorTelemetry || !dispatcherTelemetry) {
    return incompleteRuntime("runtime_worker_lookup_failed");
  }
  const collector = evaluateWorkerFromInput("collector", collectorTelemetry, input);
  const dispatcher = evaluateWorkerFromInput("dispatcher", dispatcherTelemetry, input);
  return combineRuntimeEvaluation(collector, dispatcher, parsed.baseline);
}

function parseEvaluationInput(input: EvaluationInput) {
  try {
    return {
      telemetry: assertForecastRuntimeTelemetryEvidence(input.telemetry),
      baseline: input.baseline == null ? null : assertCpuPerformanceBaseline(input.baseline),
    };
  } catch (error) {
    return { error: errorCode(error) };
  }
}

function runtimeIdentityErrors(
  telemetry: ForecastRuntimeTelemetryEvidence,
  input: EvaluationInput,
) {
  return [
    telemetry.canaryId !== input.canaryId ? "runtime_canary_id_mismatch" : null,
    telemetry.deploymentSha !== input.deploymentSha ? "runtime_deployment_sha_mismatch" : null,
    telemetry.collectorScriptVersion !== input.collectorScriptVersion
      ? "runtime_collector_script_version_identity_mismatch"
      : null,
    telemetry.dispatcherScriptVersion !== input.dispatcherScriptVersion
      ? "runtime_dispatcher_script_version_identity_mismatch"
      : null,
    telemetry.collectorScriptVersionId !== input.collectorScriptVersionId
      ? "runtime_collector_version_id_identity_mismatch"
      : null,
    telemetry.dispatcherScriptVersionId !== input.dispatcherScriptVersionId
      ? "runtime_dispatcher_version_id_identity_mismatch"
      : null,
    telemetry.startedAt !== input.startedAt ? "runtime_window_start_mismatch" : null,
    telemetry.endedAt !== input.endedAt ? "runtime_window_end_mismatch" : null,
    Date.parse(telemetry.observedAt) < Date.parse(input.endedAt)
      ? "runtime_observed_before_window_end"
      : null,
    ...(telemetry.collectionErrors ?? []),
  ].filter((value): value is string => value !== null);
}

function workerMap(telemetry: ForecastRuntimeTelemetryEvidence) {
  return new Map(telemetry.workers.map((worker) => [worker.component, worker]));
}

function missingWorkerErrors(workers: ReturnType<typeof workerMap>) {
  return (Object.keys(FORECAST_RUNTIME_WORKERS) as ForecastRuntimeComponent[])
    .filter((component) => !workers.has(component))
    .map((component) => `runtime_worker_missing:${component}`);
}

function evaluateWorkerFromInput(
  component: ForecastRuntimeComponent,
  worker: ForecastRuntimeTelemetryEvidence["workers"][number],
  input: EvaluationInput,
) {
  const collector = component === "collector";
  return evaluateWorker(
    component,
    worker,
    collector ? input.collectorScriptVersion : input.dispatcherScriptVersion,
    collector ? input.collectorScriptVersionId : input.dispatcherScriptVersionId,
    input.startedAt,
    input.endedAt,
    collector ? input.collectorExpectedSlots : input.dispatcherExpectedSlots,
    collector ? input.collectorD1Slots : input.dispatcherD1Slots,
  );
}

function combineRuntimeEvaluation(
  collector: WorkerEvaluation,
  dispatcher: WorkerEvaluation,
  baseline: CpuPerformanceBaseline | null,
): RuntimeEvaluation {
  const hardFailures = [...collector.hardFailures, ...dispatcher.hardFailures];
  const evidenceErrors = [...collector.evidenceErrors, ...dispatcher.evidenceErrors];
  const regressions = baselineEvaluations(baseline, collector.summary, dispatcher.summary);
  const regressionCodes = regressions.flatMap((value) => value.failureCodes);
  const warningCodes = [
    ...collector.warnings,
    ...dispatcher.warnings,
    ...regressions.flatMap((value) => value.warningCodes),
  ];
  const evidenceStatus = evidenceErrors.length > 0 ? "incomplete" : "valid";
  return {
    evidence: { status: evidenceStatus, errors: evidenceErrors },
    runtimeSafety: {
      status: runtimeSafetyStatus(hardFailures, evidenceStatus),
      failureCodes: hardFailures,
    },
    performance: {
      status: performanceStatus(baseline, regressionCodes, warningCodes),
      baselineId: baseline?.id ?? null,
      warnings: baseline ? warningCodes : ["performance_baseline_bootstrap", ...warningCodes],
      regressionCodes,
      collector: collector.summary,
      dispatcher: dispatcher.summary,
    },
  };
}

function baselineEvaluations(
  baseline: CpuPerformanceBaseline | null,
  collector: CpuPerformanceEvidence,
  dispatcher: CpuPerformanceEvidence,
) {
  if (!baseline) return [];
  return [
    regressionEvaluation("collector", collector, baseline.collector),
    regressionEvaluation("dispatcher", dispatcher, baseline.dispatcher),
  ];
}

function runtimeSafetyStatus(
  hardFailures: string[],
  evidenceStatus: RuntimeEvaluation["evidence"]["status"],
) {
  if (hardFailures.length > 0) return "failed" as const;
  return evidenceStatus === "incomplete" ? ("incomplete" as const) : ("passed" as const);
}

function performanceStatus(
  baseline: CpuPerformanceBaseline | null,
  regressionCodes: string[],
  warningCodes: string[],
) {
  if (!baseline) return "baseline_bootstrap" as const;
  if (regressionCodes.length > 0) return "regression" as const;
  return warningCodes.length > 0 ? ("warning" as const) : ("pass" as const);
}

export function assertCpuPerformanceBaseline(value: unknown): CpuPerformanceBaseline {
  if (!isRecord(value)) throw new Error("runtime_baseline_not_object");
  return {
    id: requiredString(value["id"], "runtime_baseline_id_invalid"),
    collector: parseBaselineWorker(value["collector"], "collector"),
    dispatcher: parseBaselineWorker(value["dispatcher"], "dispatcher"),
  };
}

function parseBaselineWorker(value: unknown, component: ForecastRuntimeComponent) {
  if (!isRecord(value)) throw new Error(`runtime_baseline_worker_invalid:${component}`);
  return {
    full: parseBaselineDistribution(value["full"], component, "full"),
    firstHalf: parseBaselineDistribution(value["firstHalf"], component, "first_half"),
    secondHalf: parseBaselineDistribution(value["secondHalf"], component, "second_half"),
  };
}

function parseBaselineDistribution(
  value: unknown,
  component: ForecastRuntimeComponent,
  segment: string,
) {
  if (!isRecord(value)) {
    throw new Error(`runtime_baseline_distribution_invalid:${component}:${segment}`);
  }
  return {
    averageMs: requiredFinite(
      value["averageMs"],
      `runtime_baseline_average_invalid:${component}:${segment}`,
    ),
    p95Ms: requiredFinite(value["p95Ms"], `runtime_baseline_p95_invalid:${component}:${segment}`),
  };
}

function evaluateWorker(
  component: ForecastRuntimeComponent,
  worker: ForecastRuntimeTelemetryEvidence["workers"][number],
  expectedScriptVersion: string,
  expectedScriptVersionId: string,
  startedAt: string,
  endedAt: string,
  expectedSlots: string[],
  d1Slots: string[],
): WorkerEvaluation {
  const expected = new Set(expectedSlots.map(normalizeSlot));
  const d1 = new Set(d1Slots.map(normalizeSlot));
  const inspection = inspectWorkerSamples(
    worker.samples,
    expectedScriptVersion,
    expectedScriptVersionId,
  );
  const summary = buildWorkerSummary(worker, inspection, expected, d1, startedAt, endedAt);
  return {
    summary,
    hardFailures: workerHardFailures(component, worker, inspection, summary),
    evidenceErrors: workerEvidenceErrors(component, summary),
    warnings: workerWarnings(component, summary),
  };
}

function inspectWorkerSamples(
  samples: ForecastRuntimeSample[],
  expectedScriptVersion: string,
  expectedScriptVersionId: string,
): WorkerSampleInspection {
  const slotCounts = new Map<string, number>();
  const requestHashes = new Set<string>();
  let duplicateRequests = 0;
  let unsuccessfulOutcomes = 0;
  let exceededCpu = 0;
  let deploymentMismatches = 0;
  let markerOnlyIdentities = 0;
  let versionIdOnlyIdentities = 0;
  let invalidSamples = 0;

  for (const sample of samples) {
    const slot = normalizeSlot(sample.slot);
    slotCounts.set(slot, (slotCounts.get(slot) ?? 0) + 1);
    if (requestHashes.has(sample.requestIdHash)) duplicateRequests += 1;
    requestHashes.add(sample.requestIdHash);
    if (!isSuccessfulOutcome(sample.outcome)) unsuccessfulOutcomes += 1;
    if (sample.outcome.toLowerCase() === "exceededcpu") exceededCpu += 1;
    if (sampleVersionMismatch(sample, expectedScriptVersion, expectedScriptVersionId))
      deploymentMismatches += 1;
    if (sample.identitySource === "marker") markerOnlyIdentities += 1;
    if (sample.identitySource === "version_id") versionIdOnlyIdentities += 1;
    if (sampleInvalid(sample, slot)) invalidSamples += 1;
  }
  return {
    slotCounts,
    duplicateRequests,
    unsuccessfulOutcomes,
    exceededCpu,
    deploymentMismatches,
    markerOnlyIdentities,
    versionIdOnlyIdentities,
    invalidSamples,
  };
}

function sampleVersionMismatch(
  sample: ForecastRuntimeSample,
  expectedScriptVersion: string,
  expectedScriptVersionId: string,
) {
  return (
    (sample.scriptVersionTag !== null && sample.scriptVersionTag !== expectedScriptVersion) ||
    (sample.scriptVersionId !== null && sample.scriptVersionId !== expectedScriptVersionId)
  );
}

function sampleInvalid(sample: ForecastRuntimeSample, slot: string) {
  return (
    sample.eventType !== "scheduled" ||
    !Number.isFinite(sample.cpuTimeMs) ||
    sample.cpuTimeMs < 0 ||
    slot === "invalid"
  );
}

function buildWorkerSummary(
  worker: ForecastRuntimeTelemetryEvidence["workers"][number],
  inspection: WorkerSampleInspection,
  expected: Set<string>,
  d1: Set<string>,
  startedAt: string,
  endedAt: string,
): CpuPerformanceEvidence {
  const telemetrySlots = new Set(inspection.slotCounts.keys());
  const duplicateSlots = [...inspection.slotCounts.values()].filter((count) => count > 1).length;
  const unmatchedTelemetrySlots = [...telemetrySlots].filter(
    (slot) => !expected.has(slot) || !d1.has(slot),
  ).length;
  const missingTelemetrySlots = [...d1].filter((slot) => !telemetrySlots.has(slot)).length;
  const splitMs = Date.parse(startedAt) + (Date.parse(endedAt) - Date.parse(startedAt)) / 2;
  const full = distribution(worker.samples.map((sample) => sample.cpuTimeMs));
  return {
    scriptName: worker.scriptName,
    configuredLimitMs: worker.configuredLimitMs,
    expectedSlots: expected.size,
    d1ObservedSlots: d1.size,
    telemetryObservedSlots: telemetrySlots.size,
    missingTelemetrySlots,
    coverage: ratio(d1.size - missingTelemetrySlots, d1.size),
    exceededCpu: inspection.exceededCpu,
    unsuccessfulOutcomes: inspection.unsuccessfulOutcomes,
    duplicateSlots,
    unmatchedTelemetrySlots,
    markerOnlyIdentities: inspection.markerOnlyIdentities,
    versionIdOnlyIdentities: inspection.versionIdOnlyIdentities,
    full,
    firstHalf: distributionForHalf(worker.samples, splitMs, "first"),
    secondHalf: distributionForHalf(worker.samples, splitMs, "second"),
    p99LimitRatio: worker.configuredLimitMs > 0 ? full.p99Ms / worker.configuredLimitMs : 1,
  };
}

function distributionForHalf(
  samples: ForecastRuntimeSample[],
  splitMs: number,
  half: "first" | "second",
) {
  return distribution(
    samples
      .filter((sample) =>
        half === "first" ? Date.parse(sample.slot) < splitMs : Date.parse(sample.slot) >= splitMs,
      )
      .map((sample) => sample.cpuTimeMs),
  );
}

function workerHardFailures(
  component: ForecastRuntimeComponent,
  worker: ForecastRuntimeTelemetryEvidence["workers"][number],
  inspection: WorkerSampleInspection,
  summary: CpuPerformanceEvidence,
) {
  const contract = FORECAST_RUNTIME_WORKERS[component];
  return [
    worker.scriptName !== contract.scriptName ? `runtime_script_name_mismatch:${component}` : null,
    worker.configuredLimitMs !== contract.configuredLimitMs
      ? `runtime_cpu_limit_mismatch:${component}`
      : null,
    worker.headSamplingRate !== 1 ? `runtime_sampling_rate_mismatch:${component}` : null,
    inspection.deploymentMismatches > 0 ? `runtime_script_version_mismatch:${component}` : null,
    summary.duplicateSlots > 0 || inspection.duplicateRequests > 0
      ? `runtime_duplicate_invocation:${component}`
      : null,
    summary.unmatchedTelemetrySlots > 0 ? `runtime_slot_identity_conflict:${component}` : null,
    summary.unsuccessfulOutcomes > 0 ? `runtime_unsuccessful_outcome:${component}` : null,
    summary.exceededCpu > 0 ? `runtime_exceeded_cpu:${component}` : null,
    inspection.invalidSamples > 0 ? `runtime_sample_invalid:${component}` : null,
  ].filter((value): value is string => value !== null);
}

function workerEvidenceErrors(
  component: ForecastRuntimeComponent,
  summary: CpuPerformanceEvidence,
) {
  return [
    summary.coverage < 0.99 || summary.missingTelemetrySlots > 1
      ? `runtime_telemetry_coverage_incomplete:${component}`
      : null,
  ].filter((value): value is string => value !== null);
}

function workerWarnings(component: ForecastRuntimeComponent, summary: CpuPerformanceEvidence) {
  return [
    summary.markerOnlyIdentities > 0 ? `runtime_version_metadata_unavailable:${component}` : null,
    summary.versionIdOnlyIdentities > 0 ? `runtime_version_tag_unavailable:${component}` : null,
    summary.p99LimitRatio >= 0.8 ? `runtime_p99_headroom_low:${component}` : null,
    summary.p99LimitRatio >= 0.95 ? `runtime_p99_headroom_critical:${component}` : null,
    summary.full.maxMs > summary.configuredLimitMs
      ? `runtime_success_above_configured_limit:${component}`
      : null,
  ].filter((value): value is string => value !== null);
}

function regressionEvaluation(
  component: ForecastRuntimeComponent,
  current: CpuPerformanceEvidence,
  baseline: CpuBaselineWorker,
) {
  const fullP95 = exceedsP95(current.full, baseline.full);
  const fullAverage = exceedsAverage(current.full, baseline.full);
  const firstHalf =
    exceedsP95(current.firstHalf, baseline.firstHalf) &&
    exceedsAverage(current.firstHalf, baseline.firstHalf);
  const secondHalf =
    exceedsP95(current.secondHalf, baseline.secondHalf) &&
    exceedsAverage(current.secondHalf, baseline.secondHalf);
  const complete = fullP95 && fullAverage && firstHalf && secondHalf;
  const partial = fullP95 || fullAverage || firstHalf || secondHalf;
  return {
    failureCodes: complete ? [`runtime_cpu_regression:${component}`] : [],
    warningCodes: partial && !complete ? [`runtime_cpu_partial_regression:${component}`] : [],
  };
}

function exceedsP95(current: Pick<CpuDistribution, "p95Ms">, baseline: { p95Ms: number }) {
  return current.p95Ms > Math.max(baseline.p95Ms * 1.2, baseline.p95Ms + 5);
}

function exceedsAverage(
  current: Pick<CpuDistribution, "averageMs">,
  baseline: { averageMs: number },
) {
  return current.averageMs > Math.max(baseline.averageMs * 1.15, baseline.averageMs + 2);
}

export function assertForecastRuntimeTelemetryEvidence(
  value: unknown,
): ForecastRuntimeTelemetryEvidence {
  if (!isRecord(value)) throw new Error("runtime_telemetry_not_object");
  if (value["version"] !== 2 || value["source"] !== FORECAST_RUNTIME_TELEMETRY_SOURCE) {
    throw new Error("runtime_telemetry_version_invalid");
  }
  const canaryId = requiredString(value["canaryId"], "runtime_canary_id_invalid");
  const deploymentSha = requiredString(value["deploymentSha"], "runtime_deployment_sha_invalid");
  const collectorScriptVersion = requiredString(
    value["collectorScriptVersion"],
    "runtime_collector_script_version_invalid",
  );
  const dispatcherScriptVersion = requiredString(
    value["dispatcherScriptVersion"],
    "runtime_dispatcher_script_version_invalid",
  );
  const collectorScriptVersionId = requiredVersionId(
    value["collectorScriptVersionId"],
    "runtime_collector_version_id_invalid",
  );
  const dispatcherScriptVersionId = requiredVersionId(
    value["dispatcherScriptVersionId"],
    "runtime_dispatcher_version_id_invalid",
  );
  if (!/^fc-[0-9a-f]{32}$/.test(canaryId)) throw new Error("runtime_canary_id_invalid");
  if (!/^[0-9a-f]{40}$/.test(deploymentSha)) throw new Error("runtime_deployment_sha_invalid");
  const startedAt = requiredTimestamp(value["startedAt"], "runtime_started_at_invalid");
  const endedAt = requiredTimestamp(value["endedAt"], "runtime_ended_at_invalid");
  const observedAt = requiredTimestamp(value["observedAt"], "runtime_observed_at_invalid");
  const collectionErrors = parseCollectionErrors(value["collectionErrors"]);
  if (Date.parse(endedAt) <= Date.parse(startedAt)) throw new Error("runtime_window_invalid");
  if (!Array.isArray(value["workers"]) || value["workers"].length !== 2) {
    throw new Error("runtime_workers_invalid");
  }
  const workers = value["workers"].map(parseWorker);
  if (new Set(workers.map((worker) => worker.component)).size !== workers.length) {
    throw new Error("runtime_workers_duplicate");
  }
  return {
    version: 2,
    source: FORECAST_RUNTIME_TELEMETRY_SOURCE,
    canaryId,
    deploymentSha,
    collectorScriptVersion,
    dispatcherScriptVersion,
    collectorScriptVersionId,
    dispatcherScriptVersionId,
    startedAt,
    endedAt,
    observedAt,
    ...(collectionErrors.length > 0 ? { collectionErrors } : {}),
    workers,
  };
}

function parseCollectionErrors(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("runtime_collection_errors_invalid");
  }
  return value.map((error) => {
    if (typeof error !== "string" || !/^[a-z0-9_:-]{1,120}$/.test(error)) {
      throw new Error("runtime_collection_error_invalid");
    }
    return error;
  });
}

function parseWorker(value: unknown): ForecastRuntimeTelemetryEvidence["workers"][number] {
  if (!isRecord(value)) throw new Error("runtime_worker_invalid");
  const component = value["component"];
  if (component !== "collector" && component !== "dispatcher") {
    throw new Error("runtime_component_invalid");
  }
  const configuredLimitMs = requiredFinite(value["configuredLimitMs"], "runtime_limit_invalid");
  if (value["headSamplingRate"] !== 1) throw new Error("runtime_sampling_rate_invalid");
  if (!Array.isArray(value["samples"]) || value["samples"].length > 1_000) {
    throw new Error("runtime_samples_invalid");
  }
  return {
    component,
    scriptName: requiredString(value["scriptName"], "runtime_script_name_invalid"),
    configuredLimitMs,
    headSamplingRate: 1,
    samples: value["samples"].map(parseSample),
  };
}

function parseSample(value: unknown): ForecastRuntimeSample {
  if (!isRecord(value)) throw new Error("runtime_sample_invalid");
  if (value["eventType"] !== "scheduled") throw new Error("runtime_event_type_invalid");
  const requestIdHash = requiredString(value["requestIdHash"], "runtime_request_hash_invalid");
  if (!/^[0-9a-f]{64}$/.test(requestIdHash)) throw new Error("runtime_request_hash_invalid");
  const scriptVersionId = optionalVersionId(value["scriptVersionId"]);
  const scriptVersionTag = optionalString(value["scriptVersionTag"], "runtime_script_tag_invalid");
  const identitySource = value["identitySource"];
  if (identitySource !== "tag" && identitySource !== "version_id" && identitySource !== "marker") {
    throw new Error("runtime_identity_source_invalid");
  }
  if (identitySource === "tag" && scriptVersionTag === null) {
    throw new Error("runtime_identity_source_invalid");
  }
  if (identitySource === "version_id" && scriptVersionId === null) {
    throw new Error("runtime_identity_source_invalid");
  }
  if (identitySource === "marker" && (scriptVersionId !== null || scriptVersionTag !== null)) {
    throw new Error("runtime_identity_source_invalid");
  }
  return {
    slot: requiredTimestamp(value["slot"], "runtime_slot_invalid"),
    requestIdHash,
    scriptVersionId,
    scriptVersionTag,
    identitySource,
    eventType: "scheduled",
    cpuTimeMs: requiredFinite(value["cpuTimeMs"], "runtime_cpu_invalid"),
    outcome: requiredString(value["outcome"], "runtime_outcome_invalid"),
  };
}

function incompleteRuntime(errors: string | string[]): RuntimeEvaluation {
  const values = Array.isArray(errors) ? errors : [errors];
  const empty = emptyCpuPerformance();
  return {
    evidence: { status: "incomplete", errors: values },
    runtimeSafety: { status: "incomplete", failureCodes: [] },
    performance: {
      status: "baseline_bootstrap",
      baselineId: null,
      warnings: ["performance_evidence_incomplete"],
      regressionCodes: [],
      collector: {
        ...empty,
        scriptName: FORECAST_RUNTIME_WORKERS.collector.scriptName,
        configuredLimitMs: FORECAST_RUNTIME_WORKERS.collector.configuredLimitMs,
      },
      dispatcher: {
        ...empty,
        scriptName: FORECAST_RUNTIME_WORKERS.dispatcher.scriptName,
        configuredLimitMs: FORECAST_RUNTIME_WORKERS.dispatcher.configuredLimitMs,
      },
    },
  };
}

function emptyCpuPerformance(): Omit<CpuPerformanceEvidence, "scriptName" | "configuredLimitMs"> {
  const empty = distribution([]);
  return {
    expectedSlots: 0,
    d1ObservedSlots: 0,
    telemetryObservedSlots: 0,
    missingTelemetrySlots: 0,
    coverage: 0,
    exceededCpu: 0,
    unsuccessfulOutcomes: 0,
    duplicateSlots: 0,
    unmatchedTelemetrySlots: 0,
    markerOnlyIdentities: 0,
    versionIdOnlyIdentities: 0,
    full: empty,
    firstHalf: empty,
    secondHalf: empty,
    p99LimitRatio: 0,
  };
}

function distribution(values: number[]): CpuDistribution {
  if (values.length === 0) {
    return { samples: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    averageMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms: nearestRank(sorted, 0.95),
    p99Ms: nearestRank(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
  };
}

function nearestRank(sorted: number[], quantile: number) {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function normalizeSlot(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(Math.floor(timestamp / 60_000) * 60_000).toISOString()
    : "invalid";
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function isSuccessfulOutcome(value: string) {
  const normalized = value.toLowerCase();
  return normalized === "ok" || normalized === "success";
}

function requiredString(value: unknown, code: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) throw new Error(code);
  return value;
}

function optionalString(value: unknown, code: string) {
  if (value === null) return null;
  return requiredString(value, code);
}

function requiredVersionId(value: unknown, code: string) {
  const versionId = requiredString(value, code);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId)) {
    throw new Error(code);
  }
  return versionId.toLowerCase();
}

function optionalVersionId(value: unknown) {
  if (value === null) return null;
  return requiredVersionId(value, "runtime_script_version_id_invalid");
}

function requiredTimestamp(value: unknown, code: string) {
  const timestamp = requiredString(value, code);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(code);
  return new Date(Date.parse(timestamp)).toISOString();
}

function requiredFinite(value: unknown, code: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
}

function errorCode(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 120) : "runtime_telemetry_invalid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
