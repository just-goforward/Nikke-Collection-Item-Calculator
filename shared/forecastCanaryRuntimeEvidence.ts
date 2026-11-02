export const FORECAST_RUNTIME_TELEMETRY_SOURCE =
  "cloudflare-workers-observability-scheduled-v2" as const;

export type ForecastRuntimeComponent = "collector" | "dispatcher";

export type ForecastRuntimeSample = {
  mode?: string | undefined;
  admission?: string | undefined;
  slot: string;
  requestIdHash: string;
  scriptVersionId: string | null;
  scriptVersionTag: string | null;
  identitySource: "tag" | "version_id" | "marker";
  eventType: "scheduled";
  cpuTimeMs: number | null;
  outcome: string | null;
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
  const runtime = parseOptionalRuntimeSummary(value);
  return {
    ...parseSampleAdmission(value),
    slot: requiredTimestamp(value["slot"], "runtime_slot_invalid"),
    requestIdHash,
    scriptVersionId,
    scriptVersionTag,
    identitySource,
    eventType: "scheduled",
    ...runtime,
  };
}

function parseSampleAdmission(value: Record<string, unknown>) {
  return {
    mode: optionalString(value["mode"] ?? null, "runtime_mode_invalid") ?? undefined,
    admission: optionalString(value["admission"] ?? null, "runtime_admission_invalid") ?? undefined,
  };
}

function parseOptionalRuntimeSummary(value: Record<string, unknown>) {
  const cpuTimeMs = value["cpuTimeMs"];
  const outcome = value["outcome"];
  if (cpuTimeMs === null && outcome === null) return { cpuTimeMs: null, outcome: null };
  if (cpuTimeMs === null || outcome === null) throw new Error("runtime_summary_partial");
  return {
    cpuTimeMs: requiredFinite(cpuTimeMs, "runtime_cpu_invalid"),
    outcome: requiredString(outcome, "runtime_outcome_invalid"),
  };
}

export function requiredString(value: unknown, code: string) {
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
  const timestampMs = Date.parse(requiredString(value, code));
  if (!Number.isFinite(timestampMs)) throw new Error(code);
  return new Date(timestampMs).toISOString();
}

export function requiredFinite(value: unknown, code: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
