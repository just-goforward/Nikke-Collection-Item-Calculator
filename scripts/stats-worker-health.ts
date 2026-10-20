import { readBoundedJson } from "../shared/boundedHttp.ts";

export const STATS_GATEWAY_ORIGIN = "https://nikkecollection.com";
export const STATS_PROBE_PATH = "/api/_ci/stats-health";
const PROFILE_ORIGINS = {
  direct: "https://collection-kit-stats.tbvj159.workers.dev",
  "direct-staging": "https://collection-kit-stats-staging.tbvj159.workers.dev",
  gateway: STATS_GATEWAY_ORIGIN,
};

export type StatsSmokeProfile = keyof typeof PROFILE_ORIGINS;
export type StatsProbeConfiguration = {
  endpoint: string;
  profile: StatsSmokeProfile;
  token: string | undefined;
};

export function statsProbeConfiguration(
  endpoint: string,
  profile: string | undefined,
  token?: string,
): StatsProbeConfiguration {
  if (profile !== "direct" && profile !== "direct-staging" && profile !== "gateway") {
    throw new Error("stats smoke: explicit direct|direct-staging|gateway profile required");
  }
  const origin = PROFILE_ORIGINS[profile];
  if (endpoint !== origin) {
    throw new Error("stats smoke: endpoint/profile mismatch");
  }
  if (profile === "gateway" && (!token || !/^[A-Za-z0-9_-]{43,}$/.test(token))) {
    throw new Error("stats smoke: missing or invalid probe secret");
  }
  return { endpoint: origin, profile, token: profile === "gateway" ? token : undefined };
}

type HealthPayload = {
  acceptedRecoveryPolicyVersions?: unknown;
  acceptedRecoveryVersions?: unknown;
  error?: unknown;
  ok?: unknown;
  retryable?: unknown;
  schemaContractVersion?: unknown;
};

export type HealthProbeOptions = {
  configuration: StatsProbeConfiguration;
  allowedOrigin: string;
  // null proves backend reachability, including crashes and failed authenticated binding calls.
  // It is not a backend-health success or permission to bypass the quota guard.
  expectedContractVersion: number | null;
  attempts?: number;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  deadlineMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
};

export type ExpectedHealth = {
  payload: HealthPayload;
  response: Response;
  attempts: number;
};

function healthError(status: number, code: string) {
  // Never print payloads, headers, URLs or fetch exception messages containing credentials.
  return new Error(`health: ${code} (${status})`);
}

export class HealthTransportError extends Error {
  constructor(
    status: number,
    code:
      | "service_unavailable"
      | "service_not_configured"
      | "redirect rejected"
      | "rate limited retry exhausted"
      | "challenge retry exhausted"
      | "public contract challenge",
  ) {
    super(`health: verification unavailable (transport): ${code} (${status})`);
    this.name = "HealthTransportError";
  }
}

function probeOptions(options: HealthProbeOptions) {
  const {
    attempts = 60,
    fetchImpl = fetch,
    maxResponseBytes = 32 * 1024,
    requestTimeoutMs = 10_000,
    deadlineMs = 120_000,
    sleep = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration)),
    now = Date.now,
  } = options;
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 60 ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 32 * 1024 ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 10_000 ||
    deadlineMs < 1 ||
    deadlineMs > 120_000
  )
    throw new Error("health: invalid probe options");
  const configuration = statsProbeConfiguration(
    options.configuration.endpoint,
    options.configuration.profile,
    options.configuration.token,
  );
  return {
    ...options,
    configuration,
    attempts,
    fetchImpl,
    maxResponseBytes,
    requestTimeoutMs,
    deadlineMs,
    sleep,
    now,
  };
}

function healthRequest(config: StatsProbeConfiguration, allowedOrigin: string, attempt: number) {
  const url = new URL(
    config.profile === "gateway" ? STATS_PROBE_PATH : "/api/health",
    config.endpoint,
  );
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.profile !== "gateway") {
    url.searchParams.set("smokeAttempt", String(attempt));
    headers["Origin"] = allowedOrigin;
    headers["Cache-Control"] = "no-cache";
    return { url, headers };
  }
  // Last check before attaching the bearer; never follow a redirect with it.
  if (
    url.origin !== STATS_GATEWAY_ORIGIN ||
    url.pathname !== STATS_PROBE_PATH ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("health: unapproved probe target");
  }
  headers["Authorization"] = `Bearer ${config.token}`;
  return { url, headers };
}

async function fetchHealth(
  request: ReturnType<typeof healthRequest>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  gateway: boolean,
): Promise<Response | undefined> {
  try {
    return await fetchImpl(request.url, {
      headers: request.headers,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Node 24.21.0 / bundled Undici 7.29.1 wraps this network error as TypeError.cause.
    // Do not inspect or print arbitrary exception text, or retry a forbidden redirect.
    if (
      gateway &&
      error instanceof TypeError &&
      error.cause instanceof Error &&
      error.cause.message === "unexpected redirect"
    ) {
      throw new HealthTransportError(0, "redirect rejected");
    }
    return undefined;
  }
}

type RetryState = {
  waitMs: number;
  backoff: number;
  lastStatus: number;
  classification: string;
  transportFailure: HealthTransportError | null;
};

function retryAfterDelay(value: string | null, nowMs: number) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const delay = Date.parse(value) - nowMs;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

async function retryUnavailableResponse(response: Response, state: RetryState, nowMs: number) {
  if (response.status === 429 || response.headers.has("cf-mitigated")) {
    const reason = response.headers.has("cf-mitigated")
      ? "challenge retry exhausted"
      : "rate limited retry exhausted";
    state.classification = reason;
    state.transportFailure = new HealthTransportError(response.status, reason);
    state.waitMs = Math.max(
      state.backoff,
      retryAfterDelay(response.headers.get("Retry-After"), nowMs),
    );
    state.backoff = Math.min(30_000, state.backoff * 2);
    await response.body?.cancel();
    return true;
  }
  state.waitMs = 1_000;
  state.transportFailure = null;
  if (response.status !== 404) return false;
  state.classification = "authentication/routing uncertainty; retry exhausted";
  await response.body?.cancel();
  return true;
}

async function readHealthPayload(
  response: Response,
  maxResponseBytes: number,
): Promise<HealthPayload> {
  let payload: unknown;
  try {
    payload = await readBoundedJson(response, maxResponseBytes, "health_response_invalid");
  } catch {
    throw healthError(response.status, "health_response_invalid");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw healthError(response.status, "health_response_invalid");
  }
  return payload as HealthPayload;
}

function isHealthy(response: Response, health: HealthPayload, expectedVersion: number | null) {
  const version = health.schemaContractVersion;
  return (
    response.status === 200 &&
    health.ok === true &&
    typeof version === "number" &&
    Number.isInteger(version) &&
    version > 0 &&
    (expectedVersion === null || version === expectedVersion)
  );
}

function hasRecoveryCapabilities(health: HealthPayload) {
  return (
    Array.isArray(health.acceptedRecoveryVersions) &&
    health.acceptedRecoveryVersions.length > 0 &&
    health.acceptedRecoveryVersions.every((value) => Number.isInteger(value) && value > 0) &&
    Array.isArray(health.acceptedRecoveryPolicyVersions) &&
    health.acceptedRecoveryPolicyVersions.length > 0 &&
    health.acceptedRecoveryPolicyVersions.every(
      (value) => typeof value === "string" && value.length > 0,
    )
  );
}

function isBackendErrorEnvelope(health: HealthPayload) {
  return (
    typeof health.error === "string" &&
    health.error.trim().length > 0 &&
    (health.ok === undefined || health.ok === false) &&
    (health.retryable === undefined || typeof health.retryable === "boolean")
  );
}

function isTransportReady(response: Response, health: HealthPayload) {
  if (response.status === 200)
    return isHealthy(response, health, null) && hasRecoveryCapabilities(health);
  // 404, 429 and challenges are intercepted before envelope verification.
  // proxy() produces 502 after auth + limiter; limiter failures produce 503.
  return (
    response.status >= 400 &&
    isBackendErrorEnvelope(health) &&
    health.error !== "service_not_configured" &&
    !(response.status === 503 && health.error === "service_unavailable")
  );
}

function isPropagationPending(
  response: Response,
  health: HealthPayload,
  expectedVersion: number | null,
) {
  if (response.status === 503) {
    return health.error === "database_schema_not_ready" && health.retryable === true;
  }
  return (
    response.status === 200 &&
    health.ok === true &&
    typeof health.schemaContractVersion === "number" &&
    expectedVersion !== null &&
    health.schemaContractVersion < expectedVersion
  );
}

async function verifyHealthResponse(
  response: Response,
  maxResponseBytes: number,
  expectedVersion: number | null,
  gateway: boolean,
) {
  const health = await readHealthPayload(response, maxResponseBytes);
  const accepted =
    expectedVersion === null
      ? isTransportReady(response, health)
      : isHealthy(response, health, expectedVersion);
  if (accepted) return health;
  if (
    gateway &&
    (response.status === 502 || response.status === 503) &&
    (health.error === "service_unavailable" || health.error === "service_not_configured")
  ) {
    throw new HealthTransportError(response.status, health.error);
  }
  if (isPropagationPending(response, health, expectedVersion)) return null;
  const code =
    health.error === "database_schema_not_ready" || health.error === "telemetry_budget_disabled"
      ? health.error
      : "unexpected contract";
  throw healthError(response.status, code);
}

export async function fetchExpectedHealthAfterDeployment(
  options: HealthProbeOptions,
): Promise<ExpectedHealth> {
  const probe = probeOptions(options);
  const deadline = probe.now() + probe.deadlineMs;
  const state: RetryState = {
    waitMs: 1_000,
    backoff: 1_000,
    lastStatus: 0,
    classification: "request retry exhausted",
    transportFailure: null,
  };
  const gateway = probe.configuration.profile === "gateway";
  for (let attempt = 1; attempt <= probe.attempts; attempt += 1) {
    // Pace even the first request, including readiness/post-deploy/restore transitions.
    if (probe.now() + state.waitMs >= deadline) break;
    await probe.sleep(state.waitMs);
    const remaining = deadline - probe.now();
    if (remaining <= 0) break;
    const request = healthRequest(probe.configuration, probe.allowedOrigin, attempt);
    const response = await fetchHealth(
      request,
      probe.fetchImpl,
      Math.min(probe.requestTimeoutMs, remaining),
      gateway,
    );
    if (!response) {
      state.classification = "request retry exhausted";
      state.transportFailure = null;
      state.waitMs = 1_000;
      continue;
    }
    state.lastStatus = response.status;
    if (await retryUnavailableResponse(response, state, probe.now())) continue;
    const health = await verifyHealthResponse(
      response,
      probe.maxResponseBytes,
      probe.expectedContractVersion,
      gateway,
    );
    if (health) return { payload: health, response, attempts: attempt };
    state.classification = "deployment propagation retry exhausted";
  }
  throw state.transportFailure ?? healthError(state.lastStatus, state.classification);
}
