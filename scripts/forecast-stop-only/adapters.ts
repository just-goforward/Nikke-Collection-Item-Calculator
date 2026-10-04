import { z } from "zod";
import { readBoundedJson } from "../../shared/boundedHttp.ts";
import { classifyReadTransport } from "./read-errors.ts";
import { type Api, type Deployment, type Registry, type Role, scripts } from "./types.ts";

const deployment = z.object({
  id: z.uuid(),
  created_on: z.iso.datetime(),
  versions: z.array(z.object({ version_id: z.uuid(), percentage: z.number() })),
  annotations: z.object({ "workers/message": z.string().optional() }).optional(),
});
const deployments = z.object({
  success: z.literal(true),
  result: z.object({ deployments: z.array(deployment) }),
  result_info: z.object({ total_pages: z.number().int().nonnegative().optional() }).optional(),
});
const version = z.object({
  success: z.literal(true),
  result: z.object({
    id: z.uuid(),
    resources: z.object({
      bindings: z.array(
        z.object({
          type: z.string(),
          name: z.string(),
          text: z.string().optional(),
        }),
      ),
    }),
  }),
});
const runs = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(z.object({ id: z.number().int(), status: z.string() })),
});

type AdapterConfig = {
  accountId: string;
  repository: string;
  githubToken: string;
  cloudflareToken: string;
  fetchImpl?: typeof fetch;
};

function requester(config: AdapterConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  return async function request(
    origin: "github" | "cloudflare",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = origin === "github" ? config.githubToken : config.cloudflareToken;
    if (!token) throw new Error("adapter_credential_missing");
    const base =
      origin === "github" ? "https://api.github.com" : "https://api.cloudflare.com/client/v4";
    let response: Response;
    try {
      response = await fetchImpl(base + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw body === undefined ? classifyReadTransport(error) : error;
    }
    if (!response.ok) throw new Error(`api_http_${response.status}`);
    return readBoundedJson(response, 262_144, "api_response_invalid");
  };
}

export function restAdapters(config: AdapterConfig): Api {
  if (
    !/^[a-f0-9]{32}$/.test(config.accountId) ||
    config.repository !== "just-goforward/Nikke-Collection-Item-Calculator"
  )
    throw new Error("adapter_scope_invalid");
  const request = requester(config);
  function scriptPath(registry: Registry, role: Role) {
    if (registry.accountId !== config.accountId || registry.workers[role].script !== scripts[role])
      throw new Error("adapter_scope_invalid");
    return `/accounts/${config.accountId}/workers/scripts/${registry.workers[role].script}`;
  }
  async function history(registry: Registry, role: Role): Promise<Deployment[]> {
    const all = new Map<string, Deployment>();
    for (let page = 1; page <= 100; page++) {
      const report = deployments.parse(
        await request(
          "cloudflare",
          `${scriptPath(registry, role)}/deployments?per_page=100&page=${page}`,
        ),
      );
      for (const item of report.result.deployments) {
        const entry = {
          id: item.id,
          createdOn: item.created_on,
          versions: item.versions.map((v) => ({
            versionId: v.version_id,
            percentage: v.percentage,
          })),
          message: item.annotations?.["workers/message"] ?? "",
        };
        const previous = all.get(entry.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
          throw new Error("history_changed_during_pagination");
        all.set(entry.id, entry);
      }
      const pages = report.result_info?.total_pages;
      if (pages !== undefined ? page >= pages : report.result.deployments.length < 100)
        return [...all.values()];
    }
    throw new Error("history_pagination_incomplete");
  }
  return {
    async registry() {
      const raw = z
        .object({ value: z.string().max(8192) })
        .parse(
          await request(
            "github",
            `/repos/${config.repository}/actions/variables/FORECAST_STAGING_PAUSED_PAIR`,
          ),
        );
      return JSON.parse(raw.value);
    },
    async version(registry, role) {
      const raw = version.parse(
        await request(
          "cloudflare",
          `${scriptPath(registry, role)}/versions/${registry.workers[role].versionId}`,
        ),
      ).result;
      const flags: Record<string, string> = {};
      for (const binding of raw.resources.bindings)
        if (
          binding.type === "plain_text" &&
          binding.text !== undefined &&
          ["ENVIRONMENT", "COLLECT_ENABLED", "DISPATCH_ENABLED"].includes(binding.name)
        ) {
          if (binding.name in flags) throw new Error("version_flags_ambiguous");
          flags[binding.name] = binding.text;
        }
      return { id: raw.id, flags };
    },
    history,
    async active(registry, role) {
      const entries = (await history(registry, role)).sort(
        (a, b) => Date.parse(b.createdOn) - Date.parse(a.createdOn),
      );
      const newest = entries[0];
      if (
        !newest ||
        (entries[1] !== undefined &&
          Date.parse(entries[1].createdOn) === Date.parse(newest.createdOn))
      )
        throw new Error("active_deployment_ambiguous");
      return newest;
    },
    async deploy(registry, role, message) {
      if (Buffer.byteLength(message, "utf8") > 1000) throw new Error("deployment_message_too_long");
      return z.object({ success: z.literal(true), result: z.object({ id: z.uuid() }) }).parse(
        await request("cloudflare", `${scriptPath(registry, role)}/deployments`, {
          strategy: "percentage",
          versions: [{ version_id: registry.workers[role].versionId, percentage: 100 }],
          annotations: { "workers/message": message },
        }),
      ).result;
    },
    async activeRuns() {
      let active = 0;
      for (let page = 1; page <= 100; page++) {
        const result = runs.parse(
          await request(
            "github",
            `/repos/${config.repository}/actions/workflows/forecast-d1-budget-watch.yml/runs?per_page=100&page=${page}`,
          ),
        );
        active += result.workflow_runs.filter((run) => run.status !== "completed").length;
        if (result.workflow_runs.length < 100 || page * 100 >= result.total_count) return active;
      }
      throw new Error("runs_pagination_incomplete");
    },
  };
}
