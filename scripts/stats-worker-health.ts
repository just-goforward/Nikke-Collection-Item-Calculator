type HealthPayload = {
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

export async function fetchExpectedHealthAfterDeployment({
  allowedOrigin,
  attempts,
  delayMs,
  endpointUrl,
  expectedContractVersion,
  fetchImpl = fetch,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}: HealthProbeOptions): Promise<ExpectedHealth> {
  let lastPayload: unknown = null;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const url = endpointUrl("api/health");
    url.searchParams.set("smokeAttempt", String(attempt));
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        Origin: allowedOrigin,
      },
    });
    lastStatus = response.status;

    if (response.status === 404) {
      if (attempt < attempts) {
        await sleep(delayMs);
        continue;
      }
      throw healthError(response, null);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw healthError(response, "invalid_json");
    }
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

  throw new Error(
    `health: deployment propagation retry exhausted (${lastStatus}): ${JSON.stringify(lastPayload)}`,
  );
}
