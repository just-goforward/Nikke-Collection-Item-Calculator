import { createHash } from "node:crypto";
import {
  FORECAST_RUNTIME_TELEMETRY_SOURCE,
  FORECAST_RUNTIME_WORKERS,
  type ForecastRuntimeComponent,
  type ForecastRuntimeSample,
  type ForecastRuntimeTelemetryEvidence,
} from "../../shared/forecastCanaryRuntime.ts";

const API_BASE = "https://api.cloudflare.com/client/v4";
const QUERY_LIMIT = 2_000;
const MARKER_EVENT = "forecast_canary_scheduled_invocation";

export type ObservabilityQueryOptions = {
  accountId: string;
  token: string;
  canaryId: string;
  deploymentSha: string;
  startedAt: string;
  endedAt: string;
  collectorScriptVersion: string;
  dispatcherScriptVersion: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
};

export function unavailableForecastRuntimeTelemetry(
  options: Omit<ObservabilityQueryOptions, "accountId" | "token" | "fetchImpl">,
  error: unknown,
): ForecastRuntimeTelemetryEvidence {
  const code = sanitizeCollectionError(error);
  return {
    version: 1,
    source: FORECAST_RUNTIME_TELEMETRY_SOURCE,
    canaryId: options.canaryId,
    deploymentSha: options.deploymentSha,
    collectorScriptVersion: options.collectorScriptVersion,
    dispatcherScriptVersion: options.dispatcherScriptVersion,
    startedAt: new Date(Date.parse(options.startedAt)).toISOString(),
    endedAt: new Date(Date.parse(options.endedAt)).toISOString(),
    observedAt: new Date().toISOString(),
    collectionErrors: [code],
    workers: (Object.keys(FORECAST_RUNTIME_WORKERS) as ForecastRuntimeComponent[]).map(
      (component) => ({
        component,
        scriptName: FORECAST_RUNTIME_WORKERS[component].scriptName,
        configuredLimitMs: FORECAST_RUNTIME_WORKERS[component].configuredLimitMs,
        headSamplingRate: 1 as const,
        samples: [],
      }),
    ),
  };
}

export function buildInvocationQuery(scriptName: string, startedAt: string, endedAt: string) {
  return {
    queryId: `forecast-canary-v9-${scriptName}`,
    timeframe: {
      from: Date.parse(startedAt),
      to: Date.parse(endedAt),
    },
    view: "invocations",
    limit: QUERY_LIMIT,
    dry: true,
    parameters: {
      datasets: ["cloudflare-workers"],
      filterCombination: "and",
      filters: [
        {
          key: "$metadata.service",
          operation: "eq",
          type: "string",
          value: scriptName,
        },
      ],
    },
  };
}

export async function collectForecastRuntimeTelemetry(
  options: ObservabilityQueryOptions,
): Promise<ForecastRuntimeTelemetryEvidence> {
  assertOptions(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl =
    options.sleepImpl ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const workers = await Promise.all(
    (Object.keys(FORECAST_RUNTIME_WORKERS) as ForecastRuntimeComponent[]).map(async (component) => {
      const contract = FORECAST_RUNTIME_WORKERS[component];
      const expectedScriptVersion =
        component === "collector"
          ? options.collectorScriptVersion
          : options.dispatcherScriptVersion;
      const response = await runQuery(
        fetchImpl,
        options.accountId,
        options.token,
        buildInvocationQuery(contract.scriptName, options.startedAt, options.endedAt),
        sleepImpl,
      );
      return {
        component,
        scriptName: contract.scriptName,
        configuredLimitMs: contract.configuredLimitMs,
        headSamplingRate: 1 as const,
        samples: await parseInvocationSamples(response, {
          component,
          scriptName: contract.scriptName,
          deploymentSha: options.deploymentSha,
          expectedScriptVersion,
          startedAt: options.startedAt,
          endedAt: options.endedAt,
        }),
      };
    }),
  );
  return {
    version: 1,
    source: FORECAST_RUNTIME_TELEMETRY_SOURCE,
    canaryId: options.canaryId,
    deploymentSha: options.deploymentSha,
    collectorScriptVersion: options.collectorScriptVersion,
    dispatcherScriptVersion: options.dispatcherScriptVersion,
    startedAt: new Date(Date.parse(options.startedAt)).toISOString(),
    endedAt: new Date(Date.parse(options.endedAt)).toISOString(),
    observedAt: new Date().toISOString(),
    workers,
  };
}

export async function parseInvocationSamples(
  response: unknown,
  expected: {
    component: ForecastRuntimeComponent;
    scriptName: string;
    deploymentSha: string;
    expectedScriptVersion: string;
    startedAt: string;
    endedAt: string;
  },
): Promise<ForecastRuntimeSample[]> {
  const result = responseResult(response);
  const invocations = result["invocations"];
  if (!isRecord(invocations)) throw new Error("observability_invocations_missing");
  const entries = Object.entries(invocations);
  if (entries.length >= QUERY_LIMIT) throw new Error("observability_page_limit_reached");
  const samples: ForecastRuntimeSample[] = [];
  for (const [requestId, rawEvents] of entries) {
    const sample = await parseInvocationEntry(requestId, rawEvents, expected);
    if (sample) samples.push(sample);
  }
  return samples.sort((left, right) => left.slot.localeCompare(right.slot));
}

async function parseInvocationEntry(
  requestId: string,
  rawEvents: unknown,
  expected: Parameters<typeof parseInvocationSamples>[1],
) {
  if (!Array.isArray(rawEvents)) throw new Error("observability_invocation_events_invalid");
  const events = rawEvents.filter(isRecord);
  const marker = events.map(readMarker).find((value) => value !== null);
  if (!marker) return null;
  assertMarkerIdentity(marker, expected);
  const runtime = readRuntimeEvent(events, expected.scriptName);
  const slot = assertMarkerSlot(marker.slot, expected.startedAt, expected.endedAt);
  return {
    slot,
    requestIdHash: createHash("sha256").update(requestId).digest("hex"),
    scriptVersion: runtime.scriptVersion,
    eventType: "scheduled" as const,
    cpuTimeMs: runtime.cpuTimeMs,
    outcome: runtime.outcome,
  };
}

function assertMarkerIdentity(
  marker: NonNullable<ReturnType<typeof readMarker>>,
  expected: Parameters<typeof parseInvocationSamples>[1],
) {
  if (marker.component !== expected.component || marker.deploymentSha !== expected.deploymentSha) {
    throw new Error("observability_marker_identity_invalid");
  }
}

function readRuntimeEvent(events: Record<string, unknown>[], expectedScriptName: string) {
  const runtimeEvent = events.find((event) => {
    const workers = event["$workers"];
    return isRecord(workers) && Number.isFinite(workers["cpuTimeMs"]);
  });
  if (!runtimeEvent) throw new Error("observability_runtime_event_missing");
  const workers = runtimeEvent["$workers"];
  if (!isRecord(workers)) throw new Error("observability_workers_payload_missing");
  if (workers["eventType"] !== "scheduled" || workers["scriptName"] !== expectedScriptName) {
    throw new Error("observability_scheduled_identity_invalid");
  }
  return parseRuntimeShape(workers);
}

function parseRuntimeShape(workers: Record<string, unknown>) {
  const outcome = workers["outcome"];
  const cpuTimeMs = workers["cpuTimeMs"];
  const scriptVersion = workers["scriptVersion"];
  if (
    typeof outcome !== "string" ||
    typeof cpuTimeMs !== "number" ||
    !Number.isFinite(cpuTimeMs) ||
    cpuTimeMs < 0 ||
    !isRecord(scriptVersion) ||
    typeof scriptVersion["tag"] !== "string"
  ) {
    throw new Error("observability_runtime_shape_invalid");
  }
  return { outcome, cpuTimeMs, scriptVersion: scriptVersion["tag"] };
}

function assertMarkerSlot(value: string, startedAt: string, endedAt: string) {
  const slotMs = Date.parse(value);
  if (!Number.isFinite(slotMs) || slotMs < Date.parse(startedAt) || slotMs >= Date.parse(endedAt)) {
    throw new Error("observability_marker_slot_outside_window");
  }
  return new Date(slotMs).toISOString();
}

function readMarker(event: Record<string, unknown>) {
  const candidates = [
    event["source"],
    isRecord(event["$metadata"]) ? event["$metadata"]["message"] : null,
  ];
  for (const candidate of candidates) {
    const parsed = parseSource(candidate);
    if (
      isRecord(parsed) &&
      parsed["event"] === MARKER_EVENT &&
      (parsed["component"] === "collector" || parsed["component"] === "dispatcher") &&
      typeof parsed["deploymentSha"] === "string" &&
      typeof parsed["slot"] === "string"
    ) {
      return {
        component: parsed["component"],
        deploymentSha: parsed["deploymentSha"],
        slot: parsed["slot"],
      };
    }
  }
  return null;
}

function parseSource(value: unknown): unknown {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function runQuery(
  fetchImpl: typeof fetch,
  accountId: string,
  token: string,
  body: ReturnType<typeof buildInvocationQuery>,
  sleepImpl: (milliseconds: number) => Promise<void>,
) {
  const url = `${API_BASE}/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/query`;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) throw new Error(`observability_http_${response.status}`);
        lastError = new Error(`observability_http_${response.status}`);
      } else {
        const payload: unknown = await response.json();
        responseResult(payload);
        return payload;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("observability_request_failed");
      if (
        lastError.message.startsWith("observability_http_4") &&
        lastError.message !== "observability_http_429"
      ) {
        throw lastError;
      }
    }
    if (attempt < 2) await sleepImpl(2_000 * (attempt + 1));
  }
  throw lastError ?? new Error("observability_request_failed");
}

function responseResult(response: unknown): Record<string, unknown> {
  if (!isRecord(response)) throw new Error("observability_response_invalid");
  const errors = response["errors"];
  if (Array.isArray(errors) && errors.length > 0) throw new Error("observability_api_error");
  const result = response["result"];
  if (!isRecord(result)) throw new Error("observability_result_missing");
  return result;
}

function assertOptions(options: ObservabilityQueryOptions) {
  if (!/^[0-9a-f]{32}$/.test(options.accountId))
    throw new Error("observability_account_id_invalid");
  if (!/^fc-[0-9a-f]{32}$/.test(options.canaryId))
    throw new Error("observability_canary_id_invalid");
  if (!/^[0-9a-f]{40}$/.test(options.deploymentSha)) {
    throw new Error("observability_deployment_sha_invalid");
  }
  if (Date.parse(options.endedAt) <= Date.parse(options.startedAt)) {
    throw new Error("observability_window_invalid");
  }
  if (!options.token) throw new Error("observability_token_missing");
}

function sanitizeCollectionError(error: unknown) {
  const message = error instanceof Error ? error.message : "observability_request_failed";
  const normalized = message
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .slice(0, 120);
  return normalized.length > 0 ? normalized : "observability_request_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
