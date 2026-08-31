import { base64Url, importGithubAppPrivateKey } from "./crypto.ts";

const REPOSITORY = "just-goforward/Nikke-Collection-Item-Calculator";
const REPOSITORY_NAME = "Nikke-Collection-Item-Calculator";
const WORKFLOW = "forecast-proposal.yml";
const REF = "main";
const API_VERSION = "2022-11-28";
const MAX_RESPONSE_BYTES = 32_768;

type FetchLike = typeof fetch;

type GithubDispatchConfig = {
  ENVIRONMENT: "staging" | "production";
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
};

export class GithubDispatchError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    code: string,
    options: { retryable: boolean; status?: number; retryAfterMs?: number } = {
      retryable: false,
    },
  ) {
    super(code);
    this.name = "GithubDispatchError";
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export async function dispatchProposalWorkflow(
  env: GithubDispatchConfig,
  input: { dispatchId: string; mode: "work" | "smoke" },
  options: { nowMs?: number; fetchImpl?: FetchLike } = {},
) {
  assertNumericIdentifier(env.GITHUB_APP_ID, "github_app_id_invalid");
  assertNumericIdentifier(env.GITHUB_APP_INSTALLATION_ID, "github_app_installation_id_invalid");
  if (!env.GITHUB_APP_PRIVATE_KEY) throw new GithubDispatchError("github_app_private_key_missing");

  const fetchImpl = options.fetchImpl ?? fetch;
  const jwt = await createGithubAppJwt(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
    options.nowMs ?? Date.now(),
  );
  const installationToken = await mintInstallationToken(
    env.GITHUB_APP_INSTALLATION_ID,
    jwt,
    fetchImpl,
  );
  const response = await githubFetch(
    `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: githubHeaders(`Bearer ${installationToken}`),
      body: JSON.stringify({
        ref: REF,
        inputs: {
          target_environment: env.ENVIRONMENT,
          bootstrap_solo_history: "false",
          dispatch_id: input.dispatchId,
          dispatch_mode: input.mode,
        },
      }),
    },
    fetchImpl,
  );
  if (response.status !== 204) throw githubStatusError("github_workflow_dispatch", response);
  return { status: 204 as const };
}

export async function createGithubAppJwt(appId: string, pem: string, nowMs: number) {
  assertNumericIdentifier(appId, "github_app_id_invalid");
  const nowSeconds = Math.floor(nowMs / 1_000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  let key: CryptoKey;
  try {
    key = await importGithubAppPrivateKey(pem);
  } catch {
    throw new GithubDispatchError("github_app_private_key_invalid");
  }
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

export async function probeGithubAppWorkflow(
  input: { appId: string; installationId: string; privateKey: string },
  fetchImpl: FetchLike = fetch,
) {
  assertNumericIdentifier(input.appId, "github_app_id_invalid");
  assertNumericIdentifier(input.installationId, "github_app_installation_id_invalid");
  const jwt = await createGithubAppJwt(input.appId, input.privateKey, Date.now());
  const token = await mintInstallationToken(input.installationId, jwt, fetchImpl);
  const response = await githubFetch(
    `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`,
    { method: "GET", headers: githubHeaders(`Bearer ${token}`) },
    fetchImpl,
  );
  if (!response.ok) throw githubStatusError("github_workflow_probe", response);
  const bytes = await boundedResponseBytes(response);
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  const path = isRecord(parsed) ? parsed["path"] : null;
  if (path !== `.github/workflows/${WORKFLOW}`) {
    throw new GithubDispatchError("github_workflow_probe_identity_mismatch");
  }
  return { status: response.status, workflow: WORKFLOW, ref: REF };
}

async function mintInstallationToken(installationId: string, jwt: string, fetchImpl: FetchLike) {
  const response = await githubFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubHeaders(`Bearer ${jwt}`),
      body: JSON.stringify({
        repositories: [REPOSITORY_NAME],
        permissions: { actions: "write" },
      }),
    },
    fetchImpl,
  );
  if (!response.ok) throw githubStatusError("github_installation_token", response);
  const bytes = await boundedResponseBytes(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GithubDispatchError("github_installation_token_invalid_json");
  }
  const token = isRecord(parsed) ? parsed["token"] : null;
  if (typeof token !== "string" || token.length < 20 || token.length > 512) {
    throw new GithubDispatchError("github_installation_token_missing");
  }
  return token;
}

async function githubFetch(url: string, init: RequestInit, fetchImpl: FetchLike) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8_000) });
  } catch (error) {
    const code = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
    throw new GithubDispatchError(`github_${code}`, { retryable: true });
  }
}

function githubHeaders(authorization: string) {
  return {
    accept: "application/vnd.github+json",
    authorization,
    "content-type": "application/json",
    "user-agent": "NIKKE-Forecast-Dispatcher",
    "x-github-api-version": API_VERSION,
  };
}

function githubStatusError(component: string, response: Response) {
  const status = response.status;
  const retryAfterSeconds = Number(response.headers.get("retry-after"));
  const retryAfterMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.min(retryAfterSeconds * 1_000, 15 * 60 * 1_000)
      : undefined;
  return new GithubDispatchError(`${component}_${status}`, {
    retryable: status === 429 || status >= 500,
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

async function boundedResponseBytes(response: Response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new GithubDispatchError("github_response_too_large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) {
    throw new GithubDispatchError("github_response_too_large");
  }
  return bytes;
}

function assertNumericIdentifier(value: string, code: string): asserts value is string {
  if (!/^\d{1,20}$/.test(value)) throw new GithubDispatchError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
