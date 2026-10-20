import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readBoundedJson } from "../shared/boundedHttp.ts";
import { D1_SCHEMA_CONTRACT_VERSION } from "../shared/d1SchemaContract.ts";
import {
  SOLVER_RECOVERY_EMIT_POLICY_VERSION,
  SOLVER_RECOVERY_EMIT_VERSION,
} from "../shared/solverRecoveryContract.ts";
import { StatsApiResponseSchema } from "../src/schemas.ts";
import {
  type ExpectedHealth,
  fetchExpectedHealthAfterDeployment,
  HealthTransportError,
  STATS_PROBE_PATH,
  statsProbeConfiguration,
} from "./stats-worker-health.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type SmokeOptions = {
  endpoint: string;
  profile: string | undefined;
  token?: string;
  allowedOrigin?: string;
  mode?: string;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
};
type PublicFetch = (path: string, init?: RequestInit) => Promise<Response>;

function smokeConfiguration(options: SmokeOptions) {
  const configuration = statsProbeConfiguration(options.endpoint, options.profile, options.token);
  const mode = options.mode ?? "full";
  assert(
    ["full", "frontend-contract-only", "readiness-only", "validate-only"].includes(mode),
    "stats smoke: unsupported mode",
  );
  const allowedOrigin = options.allowedOrigin ?? "https://nikkecollection.com";
  assert(
    allowedOrigin === "https://nikkecollection.com" ||
      (configuration.profile === "direct-staging" &&
        allowedOrigin === "https://staging.nikkecollection.com"),
    "stats smoke: unapproved allowed origin",
  );
  return { configuration, mode, allowedOrigin };
}

function requestBudget(fetchImpl: typeof fetch) {
  let requests = 0;
  const countedFetch: typeof fetch = (input, init) => {
    requests += 1;
    assert(requests <= 67, "stats smoke: request budget exceeded");
    return fetchImpl(input, init);
  };
  return { fetchImpl: countedFetch, count: () => requests };
}

function assertCors(response: Response, allowedOrigin: string, label: string) {
  assert(
    response.headers.get("Access-Control-Allow-Origin") === allowedOrigin,
    `${label}: allowed-origin CORS mismatch`,
  );
}

function assertRecoveryContracts(health: ExpectedHealth) {
  assert(
    Array.isArray(health.payload.acceptedRecoveryVersions) &&
      health.payload.acceptedRecoveryVersions.includes(SOLVER_RECOVERY_EMIT_VERSION),
    "health contract: recovery versions mismatch",
  );
  assert(
    Array.isArray(health.payload.acceptedRecoveryPolicyVersions) &&
      health.payload.acceptedRecoveryPolicyVersions.includes(SOLVER_RECOVERY_EMIT_POLICY_VERSION),
    "health contract: recovery policy versions mismatch",
  );
}

function publicRequests(endpoint: string, fetchImpl: typeof fetch): PublicFetch {
  return async (path, init) => {
    const response = await fetchImpl(new URL(path, endpoint), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.headers.has("cf-mitigated")) {
      throw new HealthTransportError(response.status, "public contract challenge");
    }
    return response;
  };
}

async function verifyStats(publicFetch: PublicFetch, allowedOrigin: string) {
  const statsResponse = await publicFetch("/api/stats", {
    headers: { Accept: "application/json", Origin: allowedOrigin },
  });
  assert(statsResponse.status === 200, `stats: expected 200, received ${statsResponse.status}`);
  assertCors(statsResponse, allowedOrigin, "stats");
  const stats = await readBoundedJson(statsResponse, 2 * 1024 * 1024, "stats_response_invalid");
  assert(StatsApiResponseSchema.safeParse(stats).success, "stats: frontend contract mismatch");
  return statsResponse.status;
}

async function verifyWriteContract(publicFetch: PublicFetch, allowedOrigin: string) {
  const response = await publicFetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: allowedOrigin },
    body: JSON.stringify({
      version: 1,
      eventId: `worker-smoke-${Date.now()}`,
      turnstileToken: "worker-smoke-invalid-token",
      event: {
        kind: "runtime_invariant",
        invariantVersion: 1,
        code: "worker_idle_pending",
        component: "worker_client",
        lane: "unknown",
      },
    }),
  });
  assert(response.status === 403, `write contract: expected 403, received ${response.status}`);
  assertCors(response, allowedOrigin, "write");
  const body = await readBoundedJson(response, 32 * 1024, "write_contract_response_invalid");
  assert(
    body && typeof body === "object" && "error" in body && body.error === "turnstile_failed",
    "write contract: event did not reach Turnstile verification",
  );
  return response.status;
}

async function verifyPreflights(publicFetch: PublicFetch, allowedOrigin: string, gateway: boolean) {
  const preflightStatuses: number[] = [];
  for (const origin of [allowedOrigin, "https://worker-smoke.invalid"]) {
    const response = await publicFetch("/api/stats", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
    });
    const backendStatus = origin === allowedOrigin ? 204 : 403;
    const expected = gateway ? 405 : backendStatus;
    assert(
      response.status === expected,
      `preflight: expected ${expected}, received ${response.status}`,
    );
    if (gateway) {
      assert(
        !response.headers.has("Access-Control-Allow-Origin"),
        "gateway preflight: unexpected CORS",
      );
      const body = await readBoundedJson(response, 32 * 1024, "preflight_response_invalid");
      assert(
        body && typeof body === "object" && "error" in body && body.error === "method_not_allowed",
        "gateway preflight: unexpected body",
      );
    } else if (origin === allowedOrigin) assertCors(response, allowedOrigin, "preflight");
    preflightStatuses.push(response.status);
  }
  return preflightStatuses;
}

async function verifyPublicExclusions(
  publicFetch: PublicFetch,
  allowedOrigin: string,
  gateway: boolean,
) {
  const admin = await publicFetch("/api/admin/solver-diagnostics", {
    headers: { Origin: allowedOrigin },
  });
  assert(
    gateway ? admin.status === 404 : admin.status === 403 || admin.status === 404,
    "admin: expected fail-closed response",
  );
  if (gateway) {
    for (const path of ["/api/health", STATS_PROBE_PATH]) {
      const response = await publicFetch(path);
      assert(response.status === 404, "public health: expected 404");
      const body = await readBoundedJson(response, 32 * 1024, "public_health_response_invalid");
      assert(
        body && typeof body === "object" && "error" in body && body.error === "not_found",
        "public health: unexpected body",
      );
    }
  }
  return admin.status;
}

function readinessHealthSummary(health: ExpectedHealth) {
  if (health.response.status === 200) return "healthy";
  switch (health.payload.error) {
    case "database_schema_not_ready":
    case "telemetry_budget_disabled":
    case "internal_error":
    case "service_unavailable":
      return health.payload.error;
    default:
      // Readiness accepts arbitrary backend error codes, but must never log raw error text.
      return "backend_error";
  }
}

export async function runStatsSmoke(options: SmokeOptions) {
  const { configuration, mode, allowedOrigin } = smokeConfiguration(options);
  if (mode === "validate-only") return { mode, profile: configuration.profile };
  const budget = requestBudget(options.fetchImpl ?? fetch);
  const gateway = configuration.profile === "gateway";
  const health = await fetchExpectedHealthAfterDeployment({
    configuration,
    allowedOrigin,
    expectedContractVersion: mode === "readiness-only" ? null : D1_SCHEMA_CONTRACT_VERSION,
    fetchImpl: budget.fetchImpl,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (mode === "readiness-only") {
    return {
      mode,
      transport: "backend-reached",
      health: health.response.status,
      backendHealth: readinessHealthSummary(health),
      requests: budget.count(),
    };
  }
  if (!gateway) assertCors(health.response, allowedOrigin, "health");
  assertRecoveryContracts(health);
  const publicFetch = publicRequests(configuration.endpoint, budget.fetchImpl);
  const stats = await verifyStats(publicFetch, allowedOrigin);
  const writeContract =
    mode === "full" ? await verifyWriteContract(publicFetch, allowedOrigin) : "skipped";
  const preflightStatuses = await verifyPreflights(publicFetch, allowedOrigin, gateway);
  const adminFailClosed = await verifyPublicExclusions(publicFetch, allowedOrigin, gateway);
  return {
    endpoint: configuration.endpoint,
    profile: configuration.profile,
    mode,
    health: health.response.status,
    stats,
    writeContract,
    preflight: preflightStatuses[0],
    blockedOrigin: preflightStatuses[1],
    adminFailClosed,
    requests: budget.count(),
  };
}

export function statsSmokeFailureClass(error: unknown) {
  return error instanceof HealthTransportError ? "transport" : "other";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [endpoint, allowedOrigin, mode, profile] = process.argv.slice(2);
  if (!endpoint)
    throw new Error(
      "Usage: smoke:stats-worker -- <origin> <allowed-origin> <full|frontend-contract-only|readiness-only|validate-only> <direct|direct-staging|gateway>",
    );
  try {
    console.log(
      JSON.stringify(
        await runStatsSmoke({
          endpoint,
          profile,
          ...(allowedOrigin ? { allowedOrigin } : {}),
          ...(mode ? { mode } : {}),
          ...(process.env["STATS_HEALTH_PROBE_TOKEN"]
            ? { token: process.env["STATS_HEALTH_PROBE_TOKEN"] }
            : {}),
        }),
      ),
    );
  } catch (error) {
    const output = process.env["GITHUB_OUTPUT"];
    if (output) appendFileSync(output, `verification_class=${statsSmokeFailureClass(error)}\n`);
    throw error;
  }
}
