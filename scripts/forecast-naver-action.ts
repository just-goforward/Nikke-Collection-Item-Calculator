import { parseNaverFeed } from "../forecast-collector/src/naver";
import type { NormalizedSourceItem } from "../forecast-collector/src/types";

const NAVER_FEED_URL = "https://comm-api.game.naver.com/nng_main/v1/community/lounge/nikke/feed";
const NAVER_SEARCH_URL = "https://comm-api.game.naver.com/nng_main/v2/search/feeds";
const MAX_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 10_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchNaverActionItem(
  boardId: 48 | 56,
  itemId: string,
  fetcher: FetchLike = fetch,
) {
  if (!/^\d{1,20}$/.test(itemId)) throw new Error("naver_item_id");
  const payload = await fetchGuardedJson(new URL(`${NAVER_FEED_URL}/${itemId}`), fetcher);
  return parseNaverActionDetail(payload, boardId, itemId);
}

export async function fetchNaverActionSoloHistory(
  fetcher: FetchLike = fetch,
): Promise<NormalizedSourceItem[]> {
  const candidates = new Map<string, Record<string, unknown>>();
  for (const keyword of ["솔로레이드", "솔로 레이드"]) {
    const url = new URL(NAVER_SEARCH_URL);
    url.search = new URLSearchParams({
      keyword,
      limit: "100",
      loungeId: "nikke",
      offset: "0",
      orderType: "LATEST",
      searchOption: "COMMUNITY_FEED_TITLE",
    }).toString();
    for (const row of searchRows(await fetchGuardedJson(url, fetcher))) {
      if (!isOfficialSoloOpening(row)) continue;
      const itemId = String(row["feedId"] ?? "");
      if (itemId) candidates.set(itemId, row);
    }
  }

  const items: NormalizedSourceItem[] = [];
  for (const itemId of [...candidates.keys()].slice(0, 8)) {
    const item = await fetchNaverActionItem(56, itemId, fetcher);
    if (item) items.push(item);
  }
  if (items.length < 6) throw new Error(`naver_solo_history_incomplete_${items.length}`);
  return items;
}

export async function parseNaverActionDetail(
  payload: unknown,
  boardId: 48 | 56,
  expectedItemId: string,
) {
  if (!isRecord(payload) || payload["code"] !== 200) throw new Error("naver_detail_schema_code");
  const content = payload["content"];
  if (
    !isRecord(content) ||
    !isRecord(content["feed"]) ||
    !isRecord(content["user"]) ||
    !isRecord(content["board"])
  ) {
    throw new Error("naver_detail_schema_content");
  }
  const feed = content["feed"];
  const user = content["user"];
  const board = content["board"];
  if (String(feed["feedId"] ?? "") !== expectedItemId) throw new Error("naver_detail_item_id");
  if (board["boardId"] !== boardId) throw new Error("naver_detail_board_id");
  if (user["userRoleCode"] !== "game_manager") throw new Error("naver_detail_not_official");
  if (typeof feed["contents"] !== "string") throw new Error("naver_detail_contents");

  const normalized = {
    ...content,
    feed: {
      ...feed,
      contents: normalizeSmartEditorContents(feed["contents"]),
    },
    user: { ...user, role: user["userRoleCode"] },
  };
  return (
    (
      await parseNaverFeed({ code: 200, content: { feeds: [normalized] } }, boardId, {
        structuredJsonOnly: true,
      })
    )[0] ?? null
  );
}

function normalizeSmartEditorContents(rawContents: string) {
  try {
    JSON.parse(rawContents);
    return rawContents;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Continue only for Naver SmartEditor HTML with both expected structural markers.
  }
  if (
    !rawContents.includes("SE_DOC_HEADER_START") ||
    !/<div\b[^>]*class=["'][^"']*\bse-viewer\b[^>]*>/i.test(rawContents)
  ) {
    throw new Error("naver_unstructured_body");
  }
  const text = decodeHtmlEntities(
    rawContents
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|tr)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!text) throw new Error("naver_unstructured_body");
  return JSON.stringify({ document: { components: [{ "@ctype": "textNode", value: text }] } });
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#\d+|#x[\da-f]+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity) => {
    const normalized = String(entity).toLowerCase();
    if (!normalized.startsWith("#")) return named[normalized] ?? match;
    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
    return String.fromCodePoint(codePoint);
  });
}

function searchRows(payload: unknown) {
  if (!isRecord(payload) || payload["code"] !== 200) throw new Error("naver_search_schema_code");
  const content = payload["content"];
  if (!isRecord(content) || !Array.isArray(content["feeds"])) {
    throw new Error("naver_search_schema_feeds");
  }
  return content["feeds"].filter(isRecord);
}

function isOfficialSoloOpening(row: Record<string, unknown>) {
  const title = typeof row["title"] === "string" ? normalizeWhitespace(row["title"]) : "";
  const user = row["user"];
  const board = row["board"];
  return (
    isRecord(user) &&
    user["userRoleCode"] === "game_manager" &&
    isRecord(board) &&
    board["boardId"] === 56 &&
    /솔로\s*레이드.*오픈(?:\s*예정|\s*안내)?/.test(title) &&
    !/재오픈/.test(title)
  );
}

async function fetchGuardedJson(url: URL, fetcher: FetchLike) {
  const response = await fetchWithRetry(url, fetcher);
  if (!response.ok) throw new Error(`naver_http_${response.status}`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("naver_content_type");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("naver_response_too_large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("naver_response_too_large");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("naver_malformed_json");
  }
}

async function fetchWithRetry(url: URL, fetcher: FetchLike) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetcher(url, {
        headers: {
          accept: "application/json",
          origin: "https://game.naver.com",
          referer: "https://game.naver.com/",
          "user-agent": "collection-kit-forecast-collector/1.0",
        },
        signal: controller.signal,
      });
      if (response.status >= 500 && attempt === 0) continue;
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === 1) throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("naver_fetch_failed");
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
