import { pathToFileURL } from "node:url";

export const CLOUDFLARE_PAID_CRON_TRIGGER_LIMIT = 250;

export type CronCapacity = {
  currentCount: number;
  additionalCount: number;
  projectedCount: number;
  limit: number;
  targetAlreadyScheduled: boolean;
  allowed: boolean;
};

export function parseCronTriggerLimit(value: string | undefined) {
  const limit = Number(value ?? CLOUDFLARE_PAID_CRON_TRIGGER_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > CLOUDFLARE_PAID_CRON_TRIGGER_LIMIT) {
    throw new Error("Invalid Cron trigger limit.");
  }
  return limit;
}

export function evaluateCronCapacity(
  schedulesByScript: ReadonlyMap<string, number>,
  targetScript: string,
  limit = CLOUDFLARE_PAID_CRON_TRIGGER_LIMIT,
): CronCapacity {
  const currentCount = [...schedulesByScript.values()].reduce((sum, count) => sum + count, 0);
  const targetAlreadyScheduled = (schedulesByScript.get(targetScript) ?? 0) > 0;
  const additionalCount = targetAlreadyScheduled ? 0 : 1;
  const projectedCount = currentCount + additionalCount;
  return {
    currentCount,
    additionalCount,
    projectedCount,
    limit,
    targetAlreadyScheduled,
    allowed: projectedCount <= limit,
  };
}

export async function readCronSchedules(
  accountId: string,
  apiToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  assertIdentifier(accountId, "Cloudflare account id");
  if (!apiToken) throw new Error("Missing Cloudflare API token.");
  const scriptsResponse = await cloudflareJson(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts?per_page=100`,
    apiToken,
    fetchImpl,
  );
  const scripts =
    isRecord(scriptsResponse) && Array.isArray(scriptsResponse["result"])
      ? scriptsResponse["result"]
      : null;
  if (!scripts || scripts.length > 100) throw new Error("Cloudflare scripts response is invalid.");
  const result = new Map<string, number>();
  for (const entry of scripts) {
    const id = isRecord(entry) ? entry["id"] : null;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      throw new Error("Cloudflare script id is invalid.");
    }
    const schedulesResponse = await cloudflareJson(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(id)}/schedules`,
      apiToken,
      fetchImpl,
    );
    const scheduleResult = isRecord(schedulesResponse) ? schedulesResponse["result"] : null;
    const schedules =
      isRecord(scheduleResult) && Array.isArray(scheduleResult["schedules"])
        ? scheduleResult["schedules"]
        : null;
    if (!schedules) throw new Error(`Cloudflare schedules response is invalid for ${id}.`);
    result.set(id, schedules.length);
  }
  return result;
}

async function main() {
  const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requiredEnvironment("CLOUDFLARE_API_TOKEN");
  const targetScript = requiredEnvironment("FORECAST_DISPATCHER_SCRIPT_NAME");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(targetScript)) throw new Error("Invalid target Worker name.");
  const limit = parseCronTriggerLimit(process.env["CLOUDFLARE_CRON_TRIGGER_LIMIT"]);
  const schedules = await readCronSchedules(accountId, apiToken);
  const capacity = evaluateCronCapacity(schedules, targetScript, limit);
  console.log(JSON.stringify(capacity));
  if (!capacity.allowed) {
    throw new Error(
      `Cloudflare Cron capacity exceeded: ${capacity.projectedCount}/${capacity.limit}.`,
    );
  }
}

async function cloudflareJson(url: string, token: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Cloudflare API returned ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 1_000_000) throw new Error("Cloudflare API response is too large.");
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!isRecord(parsed) || parsed["success"] !== true)
    throw new Error("Cloudflare API request failed.");
  return parsed;
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function assertIdentifier(value: string, label: string) {
  if (!/^[a-f0-9]{32}$/i.test(value)) throw new Error(`${label} is invalid.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
