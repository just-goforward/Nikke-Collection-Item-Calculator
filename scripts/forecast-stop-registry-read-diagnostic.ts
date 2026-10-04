import { pathToFileURL } from "node:url";
import { z } from "zod";
import { parseRegistry } from "./forecast-stop-only/registry.ts";

const repository = "just-goforward/Nikke-Collection-Item-Calculator";
const pairName = "FORECAST_STAGING_PAUSED_PAIR";
const base = `https://api.github.com/repos/${repository}/actions/variables`;
const timeoutMs = 10_000;
const bodyLimit = 65_536;
const listSchema = z.object({
  total_count: z.number().int().nonnegative(),
  variables: z.array(z.object({ name: z.string().min(1).max(500) })).max(1),
});
const pairSchema = z.object({ name: z.literal(pairName), value: z.string().max(8192) });
type Env = Readonly<Record<string, string | undefined>>;
type Endpoint = {
  status: number | null;
  reason: string;
  schemaValid: boolean;
};

function context(env: Env) {
  if (env["FORECAST_STOP_REGISTRY_DIAGNOSTIC_APPROVED"] !== "true")
    throw Error("diagnostic_approval_missing");
  const source = env["FORECAST_STOP_REGISTRY_TOKEN_SOURCE"];
  if (
    env["GITHUB_REPOSITORY"] !== repository ||
    !/^[a-f0-9]{32}$/.test(env["CLOUDFLARE_ACCOUNT_ID"] ?? "") ||
    !["github_token", "registry_read_token"].includes(source ?? "")
  )
    throw Error("diagnostic_context_invalid");
  const token = env["GH_TOKEN"];
  if (!token?.trim()) throw Error("adapter_credential_missing");
  return { source, token, accountId: env["CLOUDFLARE_ACCOUNT_ID"] ?? "" };
}

function identity(env: Env) {
  const field = (name: string, pattern: RegExp) => {
    const value = env[name] ?? "";
    return pattern.test(value) ? value : "";
  };
  return {
    repository: env["GITHUB_REPOSITORY"] === repository ? repository : "",
    runId: field("GITHUB_RUN_ID", /^[1-9][0-9]{0,19}$/),
    attempt: field("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]{0,5}$/),
    sourceSha: field("GITHUB_SHA", /^[a-f0-9]{40}$/),
    workflowSha: field("GITHUB_WORKFLOW_SHA", /^[a-f0-9]{40}$/),
    workflowRef: field(
      "GITHUB_WORKFLOW_REF",
      /^just-goforward\/Nikke-Collection-Item-Calculator\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@refs\/(heads|tags)\/[A-Za-z0-9_./-]{1,200}$/,
    ),
    event: field("GITHUB_EVENT_NAME", /^[a-z_]{1,50}$/),
    actor: field("GITHUB_ACTOR", /^[A-Za-z0-9[\]-]{1,100}$/),
  };
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("response_body_invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > bodyLimit) throw Error("response_body_too_large");
      chunks.push(chunk.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function httpReason(status: number) {
  if (status === 401) return "authentication_unavailable";
  if (status === 403) return "access_denied_or_restricted";
  if (status === 404) return "not_found_or_hidden";
  if (status === 429) return "rate_limited";
  return "http_unavailable";
}

async function request(url: string, token: string, fetchImpl: typeof fetch) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: number | null = null;
  const operation = async () => {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Cache-Control": "no-cache",
      },
    });
    status = response.status;
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { status, reason: httpReason(response.status), value: undefined };
    }
    return { status, reason: "ok", value: await boundedJson(response, controller.signal) };
  };
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Error("diagnostic_timeout"));
      }, timeoutMs);
    });
    return await Promise.race([operation(), timeout]);
  } catch (error) {
    const allowed = ["diagnostic_timeout", "response_body_too_large"];
    const reason =
      error instanceof Error && allowed.includes(error.message)
        ? error.message
        : "request_or_body_unavailable";
    return { status, reason, value: undefined };
  } finally {
    clearTimeout(timer);
  }
}

function classification(collection: Endpoint, pair: Endpoint) {
  if (collection.schemaValid && pair.schemaValid) return "pair_read_valid";
  if (collection.schemaValid && pair.status === 404) return "pair_absent_candidate";
  return "diagnostic_inconclusive";
}

export async function diagnoseRegistryRead(env: Env, fetchImpl: typeof fetch) {
  const config = context(env);
  const listed = await request(`${base}?per_page=1`, config.token, fetchImpl);
  const list = listSchema.safeParse(listed.value);
  const collection: Endpoint = {
    status: listed.status,
    reason: list.success
      ? "ok"
      : listed.reason === "ok"
        ? "collection_schema_invalid"
        : listed.reason,
    schemaValid: list.success,
  };
  const raw = await request(`${base}/${pairName}`, config.token, fetchImpl);
  const parsed = pairSchema.safeParse(raw.value);
  let valid = false;
  if (parsed.success) {
    try {
      parseRegistry(JSON.parse(parsed.data.value), config.accountId);
      valid = true;
    } catch {
      valid = false;
    }
  }
  const pair: Endpoint = {
    status: raw.status,
    schemaValid: valid,
    reason: valid ? "ok" : raw.reason === "ok" ? "pair_schema_invalid" : raw.reason,
  };
  return {
    format: 1,
    observedAt: new Date().toISOString(),
    tokenSource: config.source,
    identity: identity(env),
    collection,
    pair,
    classification: classification(collection, pair),
    pairReadValid: collection.schemaValid && pair.schemaValid,
    limit:
      "Point-in-time GitHub Variables GET only; no absence proof, deployment or POST capability verified.",
  };
}

export async function registryReadDiagnosticMain(env: Env, fetchImpl: typeof fetch) {
  try {
    const report = await diagnoseRegistryRead(env, fetchImpl);
    return { exitCode: report.pairReadValid ? 0 : 1, report };
  } catch (error) {
    const allowed = [
      "diagnostic_approval_missing",
      "diagnostic_context_invalid",
      "adapter_credential_missing",
    ];
    const reason =
      error instanceof Error && allowed.includes(error.message)
        ? error.message
        : "diagnostic_unavailable";
    return {
      exitCode: 1,
      report: {
        format: 1,
        observedAt: new Date().toISOString(),
        tokenSource: ["github_token", "registry_read_token"].includes(
          env["FORECAST_STOP_REGISTRY_TOKEN_SOURCE"] ?? "",
        )
          ? env["FORECAST_STOP_REGISTRY_TOKEN_SOURCE"]
          : "unknown",
        identity: identity(env),
        reason,
        pairReadValid: false,
      },
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await registryReadDiagnosticMain(process.env, fetch);
  console.log(JSON.stringify(result.report));
  process.exitCode = result.exitCode;
}
