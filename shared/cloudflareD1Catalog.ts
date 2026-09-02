import { readBoundedJson } from "./boundedHttp";

const API_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const API_TIMEOUT_MS = 20_000;
const MAX_DATABASE_PAGES = 50;

type DatabasePage = {
  entries: Array<{ id: string; name: string }>;
  totalPages: number;
};

function parseDatabasePage(body: unknown): DatabasePage {
  if (!isRecord(body) || body["success"] !== true || !Array.isArray(body["result"])) {
    throw new Error("cloudflare_d1_list_schema_invalid");
  }
  const entries = body["result"].map((item) => {
    if (!isRecord(item) || typeof item["uuid"] !== "string" || typeof item["name"] !== "string") {
      throw new Error("cloudflare_d1_list_item_invalid");
    }
    return { id: item["uuid"], name: item["name"] };
  });
  const info = body["result_info"];
  if (!isRecord(info) || !isPositiveInteger(info["total_pages"])) {
    throw new Error("cloudflare_d1_list_pagination_invalid");
  }
  if (info["total_pages"] > MAX_DATABASE_PAGES) {
    throw new Error("cloudflare_d1_list_page_limit_reached");
  }
  return { entries, totalPages: info["total_pages"] };
}

export async function listCloudflareD1Databases(
  fetchImpl: typeof fetch,
  accountId: string,
  token: string,
) {
  const names = new Map<string, string>();
  for (let page = 1; page <= MAX_DATABASE_PAGES; page += 1) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`cloudflare_d1_list_http_${response.status}`);
    const body = await readBoundedJson(
      response,
      API_RESPONSE_LIMIT_BYTES,
      "cloudflare_api_response_too_large",
    );
    const result = parseDatabasePage(body);
    for (const entry of result.entries) names.set(entry.id, entry.name);
    if (page >= result.totalPages) return names;
  }
  throw new Error("cloudflare_d1_list_pagination_incomplete");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
