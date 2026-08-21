type HealthPayload = {
  ok?: unknown;
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
    if (
      response.status === 200 &&
      health.ok === true &&
      health.schemaContractVersion === expectedContractVersion
    ) {
      return { payload: health, response };
    }

    const previousContractStillServing =
      response.status === 200 &&
      health.ok === true &&
      typeof health.schemaContractVersion === "number" &&
      health.schemaContractVersion < expectedContractVersion;
    if (previousContractStillServing && attempt < attempts) {
      await sleep(delayMs);
      continue;
    }

    throw healthError(response, payload);
  }

  throw new Error(
    `health: deployment propagation retry exhausted (${lastStatus}): ${JSON.stringify(lastPayload)}`,
  );
}
