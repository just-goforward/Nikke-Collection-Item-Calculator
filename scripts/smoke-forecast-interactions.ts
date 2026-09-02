const baseUrl = requiredArgument(2, "Router URL").replace(/\/$/, "");
const expectedSha = requiredEnvironment("FORECAST_EXPECTED_DEPLOY_SHA");
const readinessTimeoutMs = optionalDuration("FORECAST_READINESS_TIMEOUT_MS", 30_000);
const retryDelayMs = optionalDuration("FORECAST_READINESS_RETRY_MS", 1_000);
const deadline = Date.now() + readinessTimeoutMs;
let lastRetryableError = "forecast_interactions_health_not_observed";
let ready = false;

while (Date.now() < deadline) {
  const result = await probeHealth();
  if (result.ready) {
    ready = true;
    break;
  }
  if (!result.retryable) throw new Error(result.errorCode);
  lastRetryableError = result.errorCode;
  await sleep(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
}

if (!ready) throw new Error(`forecast_interactions_readiness_timeout:${lastRetryableError}`);
console.log(`Forecast interactions Router is ready at ${baseUrl}.`);

async function probeHealth(): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now()))),
    });
  } catch {
    return { ready: false, retryable: true, errorCode: "forecast_interactions_health_network" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    const retryable = response.status === 404 || response.status === 429 || response.status >= 500;
    return {
      ready: false,
      retryable,
      errorCode: `forecast_interactions_health_${response.status}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ready: false,
      retryable: false,
      errorCode: "forecast_interactions_health_json_invalid",
    };
  }
  if (!isRecord(body)) {
    return {
      ready: false,
      retryable: false,
      errorCode: "forecast_interactions_health_contract_invalid",
    };
  }
  if (body["deploymentSha"] !== expectedSha) {
    return {
      ready: false,
      retryable: true,
      errorCode: "forecast_interactions_health_identity_mismatch",
    };
  }
  if (body["status"] !== "ok") {
    return {
      ready: false,
      retryable: false,
      errorCode: "forecast_interactions_health_status_invalid",
    };
  }
  const databases = body["databases"];
  if (!isRecord(databases)) {
    return {
      ready: false,
      retryable: false,
      errorCode: "forecast_interactions_health_databases_missing",
    };
  }
  const productionEnabled = body["productionMutationsEnabled"] === true;
  for (const environment of ["staging", ...(productionEnabled ? (["production"] as const) : [])]) {
    const database = databases[environment];
    if (!isRecord(database) || Number(database["schemaVersion"]) < 8) {
      return {
        ready: false,
        retryable: true,
        errorCode: `forecast_interactions_${environment}_schema_not_ready`,
      };
    }
  }
  return { ready: true };
}

type ProbeResult = { ready: true } | { ready: false; retryable: boolean; errorCode: string };

function requiredArgument(index: number, label: string) {
  const value = process.argv[index]?.trim();
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function optionalDuration(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 120_000) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
