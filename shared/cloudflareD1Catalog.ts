import { readBoundedJson } from "./boundedHttp";

const API_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const API_TIMEOUT_MS = 20_000;
const MAX_DATABASE_PAGES = 50;

type DatabasePage = {
  entries: Array<{ id: string; name: string }>;
  totalPages: number;
  totalCount: number;
};

function parseDatabasePage(
  body: unknown,
  expectedPage: number,
  expectedPerPage: number,
): DatabasePage {
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
  if (
    !isRecord(info) ||
    !isNonNegativeInteger(info["count"]) ||
    !isPositiveInteger(info["page"]) ||
    !isPositiveInteger(info["per_page"]) ||
    !isNonNegativeInteger(info["total_count"])
  ) {
    throw new Error("cloudflare_d1_list_pagination_invalid");
  }
  const count = info["count"];
  const page = info["page"];
  const perPage = info["per_page"];
  const totalCount = info["total_count"];
  const expectedCount = Math.min(perPage, Math.max(0, totalCount - (page - 1) * perPage));
  if (
    page !== expectedPage ||
    perPage !== expectedPerPage ||
    count !== entries.length ||
    count !== expectedCount
  ) {
    throw new Error("cloudflare_d1_list_pagination_inconsistent");
  }
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
  if (totalPages > MAX_DATABASE_PAGES) {
    throw new Error("cloudflare_d1_list_page_limit_reached");
  }
  return { entries, totalPages, totalCount };
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
    const result = parseDatabasePage(body, page, 100);
    for (const entry of result.entries) {
      if (names.has(entry.id)) throw new Error("cloudflare_d1_list_duplicate_database");
      names.set(entry.id, entry.name);
    }
    if (page >= result.totalPages) {
      if (names.size !== result.totalCount) throw new Error("cloudflare_d1_list_total_mismatch");
      return names;
    }
  }
  throw new Error("cloudflare_d1_list_pagination_incomplete");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
