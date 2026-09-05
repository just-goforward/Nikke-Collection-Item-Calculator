import { readBoundedJson } from "../shared/boundedHttp.ts";

type HealthPayload = {
  acceptedRecoveryPolicyVersions?: unknown;
  acceptedRecoveryVersions?: unknown;
  error?: unknown;
  ok?: unknown;
  retryable?: unknown;
  schemaContractVersion?: unknown;
};

type HealthProbeOptions = {
  allowedOrigin: string;
  attempts: number;
  delayMs: number;
  endpointUrl: (path: string) => URL;
  expectedContractVersion: number;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

export type ExpectedHealth = {
  payload: HealthPayload;
  response: Response;
};

function healthError(response: Response, payload: unknown) {
  return new Error(
    `health: unexpected schema contract response (${response.status}): ${JSON.stringify(payload)}`,
  );
}

function isExpectedHealth(
  response: Response,
  health: HealthPayload,
  expectedContractVersion: number,
) {
  return (
    response.status === 200 &&
    health.ok === true &&
    health.schemaContractVersion === expectedContractVersion
  );
}

function isDeploymentPropagationPending(
  response: Response,
  health: HealthPayload,
  expectedContractVersion: number,
) {
  const previousContractStillServing =
    response.status === 200 &&
    health.ok === true &&
    typeof health.schemaContractVersion === "number" &&
    health.schemaContractVersion < expectedContractVersion;
  const retryableSchemaPropagation =
    response.status === 503 &&
    health.error === "database_schema_not_ready" &&
    health.retryable === true;
  return previousContractStillServing || retryableSchemaPropagation;
}

async function fetchHealthAttempt(
  url: URL,
  allowedOrigin: string,
  requestTimeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ response: Response } | { error: unknown }> {
  try {
    return {
      response: await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
          Origin: allowedOrigin,
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      }),
    };
  } catch (error) {
    return { error };
  }
}

async function readHealthPayload(response: Response, maxResponseBytes: number) {
  try {
    return await readBoundedJson(response, maxResponseBytes, "health_response_invalid");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "health_response_invalid";
    throw healthError(response, reason);
  }
}

export async function fetchExpectedHealthAfterDeployment({
  allowedOrigin,
  attempts,
  delayMs,
  endpointUrl,
  expectedContractVersion,
  fetchImpl = fetch,
  maxResponseBytes = 32 * 1024,
  requestTimeoutMs = 10_000,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}: HealthProbeOptions): Promise<ExpectedHealth> {
  if (attempts < 1 || delayMs < 0 || maxResponseBytes < 1 || requestTimeoutMs < 1) {
    throw new Error("health: invalid probe options");
  }
  let lastPayload: unknown = null;
  let lastStatus = 0;
  let lastRequestError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const url = endpointUrl("api/health");
    url.searchParams.set("smokeAttempt", String(attempt));
    const fetched = await fetchHealthAttempt(url, allowedOrigin, requestTimeoutMs, fetchImpl);
    if ("error" in fetched) {
      lastRequestError = fetched.error;
      if (attempt < attempts) {
        await sleep(delayMs);
        continue;
      }
      break;
    }
    const { response } = fetched;
    lastRequestError = null;
    lastStatus = response.status;

    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      if (attempt < attempts) {
        await sleep(delayMs);
        continue;
      }
      throw healthError(response, null);
    }

    const payload = await readHealthPayload(response, maxResponseBytes);
    lastPayload = payload;

    const health = payload as HealthPayload;
    if (isExpectedHealth(response, health, expectedContractVersion)) {
      return { payload: health, response };
    }

    if (isDeploymentPropagationPending(response, health, expectedContractVersion)) {
      if (attempt < attempts) {
        await sleep(delayMs);
        continue;
      }
      break;
    }

    throw healthError(response, payload);
  }

  if (lastRequestError !== null) {
    const reason =
      lastRequestError instanceof Error
        ? `${lastRequestError.name}: ${lastRequestError.message}`
        : String(lastRequestError);
    throw new Error(`health: request retry exhausted: ${reason}`);
  }
  throw new Error(
    `health: deployment propagation retry exhausted (${lastStatus}): ${JSON.stringify(lastPayload)}`,
  );
}
