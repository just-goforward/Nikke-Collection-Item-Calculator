import { sha256Hex } from "./crypto";
import type { NaverFeedMetadata, NormalizedSourceItem, ScheduleEvent, SourceKind } from "./types";

const NAVER_FEED_URL = "https://comm-api.game.naver.com/nng_main/v1/community/lounge/nikke/feed";
const NAVER_SEARCH_URL = "https://comm-api.game.naver.com/nng_main/v2/search/feeds";
const MAX_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 10_000;

const BOARD_KEYWORDS: Record<48 | 56, readonly string[]> = {
  56: ["솔로 레이드", "솔로레이드", "솔레", "협동 작전", "협동작전", "협작", "콜라보"],
  48: [
    "솔로 레이드",
    "솔로레이드",
    "솔레",
    "협동 작전",
    "협동작전",
    "협작",
    "콜라보",
    "중단",
    "연장",
    "재개",
    "종료",
    "일정 변경",
    "보상",
    "지급",
    "관리 키트 상자",
    "상자 II",
    "상자 Ⅱ",
  ],
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchNaverFeedMetadata(
  boardId: 48 | 56,
  offset = 0,
  fetcher: FetchLike = fetch,
): Promise<NaverFeedMetadata[]> {
  const url = new URL(NAVER_FEED_URL);
  url.search = new URLSearchParams({
    boardId: String(boardId),
    buffFilteringYN: "N",
    limit: "10",
    offset: String(offset),
    order: "NEW",
  }).toString();
  return parseNaverFeedMetadata(await readGuardedJson(await fetchWithRetry(url, fetcher)), boardId);
}

function parseNaverFeedMetadata(payload: unknown, boardId: 48 | 56) {
  if (!isRecord(payload) || payload["code"] !== 200) throw new Error("naver_schema_code");
  const content = payload["content"];
  if (!isRecord(content) || !Array.isArray(content["feeds"])) throw new Error("naver_schema_feeds");
  const result: NaverFeedMetadata[] = [];
  for (const row of content["feeds"]) {
    if (!isRecord(row) || !isRecord(row["feed"]) || !isRecord(row["user"])) continue;
    const feed = row["feed"];
    const user = row["user"];
    const itemId = String(feed["feedId"] ?? "");
    const title = typeof feed["title"] === "string" ? normalizeWhitespace(feed["title"]) : "";
    if (!itemId || !title) continue;
    result.push({
      source: `naver-board-${boardId}`,
      itemId,
      url: readFeedUrl(row, itemId),
      title,
      publishedAt: parseNaverDate(feed["createdDate"]),
      official: user["role"] === "game_manager" || user["userRoleCode"] === "game_manager",
    });
  }
  return result;
}

export async function fetchNaverStructuredItem(
  boardId: 48 | 56,
  itemId: string,
  fetcher: FetchLike = fetch,
) {
  if (!/^\d{1,20}$/.test(itemId)) throw new Error("naver_item_id");
  const payload = await readGuardedJson(
    await fetchWithRetry(new URL(`${NAVER_FEED_URL}/${itemId}`), fetcher),
  );
  return parseNaverDetail(payload, boardId, true);
}

export async function fetchNaverBoard(
  boardId: 48 | 56,
  fetcher: FetchLike = fetch,
): Promise<NormalizedSourceItem[]> {
  const url = new URL(NAVER_FEED_URL);
  url.search = new URLSearchParams({
    boardId: String(boardId),
    buffFilteringYN: "N",
    limit: "30",
    offset: "0",
    order: "NEW",
  }).toString();
  const response = await fetchWithRetry(url, fetcher);
  const payload = await readGuardedJson(response);
  return parseNaverFeed(payload, boardId);
}

export async function fetchNaverSoloHistory(
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
    for (const row of searchRows(await readGuardedJson(await fetchWithRetry(url, fetcher)))) {
      if (!isOfficialSoloOpening(row)) continue;
      const feedId = String(row["feedId"] ?? "");
      if (feedId) candidates.set(feedId, row);
    }
  }

  const items: NormalizedSourceItem[] = [];
  for (const feedId of [...candidates.keys()].slice(0, 8)) {
    const url = new URL(`${NAVER_FEED_URL}/${feedId}`);
    const payload = await readGuardedJson(await fetchWithRetry(url, fetcher));
    const item = await parseNaverDetail(payload, 56, true);
    if (item) items.push(item);
  }
  return items;
}

export async function parseNaverFeed(
  payload: unknown,
  boardId: 48 | 56,
  options: { structuredJsonOnly?: boolean } = {},
): Promise<NormalizedSourceItem[]> {
  if (!isRecord(payload) || payload["code"] !== 200) throw new Error("naver_schema_code");
  const content = payload["content"];
  if (!isRecord(content) || !Array.isArray(content["feeds"])) throw new Error("naver_schema_feeds");
  const result: NormalizedSourceItem[] = [];
  const seen = new Set<string>();
  for (const row of content["feeds"]) {
    if (!isRecord(row) || !isRecord(row["feed"]) || !isRecord(row["user"])) continue;
    const feed = row["feed"];
    const user = row["user"];
    const itemId = String(feed["feedId"] ?? "");
    const title = typeof feed["title"] === "string" ? normalizeWhitespace(feed["title"]) : "";
    const rawContents = typeof feed["contents"] === "string" ? feed["contents"] : "";
    const extracted = await extractSmartEditorText(
      rawContents,
      options.structuredJsonOnly === true,
    );
    if (options.structuredJsonOnly === true && !extracted.structured) {
      throw new Error("naver_unstructured_body");
    }
    const normalizedText = normalizeWhitespace(`${title}\n${extracted.text}`);
    if (!itemId || !title || !hasRelevantKeyword(normalizedText, BOARD_KEYWORDS[boardId])) continue;
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    const source = `naver-board-${boardId}` as SourceKind;
    const url = readFeedUrl(row, itemId);
    const publishedAt = parseNaverDate(feed["createdDate"]);
    const excerpt = relevantExcerpt(normalizedText, BOARD_KEYWORDS[boardId]);
    result.push({
      source,
      itemId,
      url,
      title,
      excerpt,
      normalizedText,
      publishedAt,
      contentHash: await sha256Hex(normalizedText),
      structured: extracted.structured,
      official: user["role"] === "game_manager" || user["userRoleCode"] === "game_manager",
    });
  }
  return result;
}

export async function parseScheduleEvents(
  items: readonly NormalizedSourceItem[],
): Promise<ScheduleEvent[]> {
  const events: ScheduleEvent[] = [];
  for (const item of items) {
    const text = item.normalizedText;
    const schedule = parseKoreanDateRange(text, item.publishedAt);
    const manualReview =
      !item.structured ||
      !item.official ||
      /점검\s*완료\s*후/.test(text) ||
      (/(중단|연장|재개|일정\s*변경)/.test(text) && schedule === null);
    const eventType = classifyEvent(text);
    if (!eventType) continue;
    const eventId = `${item.source}:${item.itemId}:${eventType}`;
    events.push({
      eventId,
      eventType,
      sourceItem: item,
      startsAt: schedule?.start ?? null,
      endsAt: schedule?.end ?? null,
      scheduleStatus: "confirmed",
      manualReview,
      reason: manualReview
        ? !item.official
          ? "not_official_manager"
          : !item.structured
            ? "unstructured_body"
            : "ambiguous_schedule_change"
        : null,
    });
  }
  return events;
}

async function extractSmartEditorText(
  rawContents: string,
  structuredJsonOnly = false,
): Promise<{
  text: string;
  structured: boolean;
}> {
  try {
    const parsed: unknown = JSON.parse(rawContents);
    const values: string[] = [];
    visit(parsed, values);
    if (values.length > 0) return { text: values.join("\n"), structured: true };
  } catch {
    if (structuredJsonOnly) return { text: "", structured: false };
    const smartEditorHtml = await extractSmartEditorHtmlText(rawContents);
    if (smartEditorHtml !== null) return { text: smartEditorHtml, structured: true };
  }
  return {
    text: await extractUnstructuredHtmlText(rawContents),
    structured: false,
  };
}

async function extractUnstructuredHtmlText(rawContents: string) {
  const sanitized = await new HTMLRewriter()
    .on("script, style, template", {
      element(element) {
        element.remove();
      },
    })
    .transform(
      new Response(rawContents, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    )
    .text();
  const values: string[] = [];
  let sawBody = false;
  const response = new HTMLRewriter()
    .on("body", {
      element() {
        sawBody = true;
      },
      text(chunk) {
        values.push(chunk.text);
      },
    })
    .transform(
      new Response(sanitized, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  await response.text();
  return sawBody ? normalizeWhitespace(values.join(" ")) : "";
}

async function extractSmartEditorHtmlText(rawContents: string) {
  if (
    !rawContents.includes("SE_DOC_HEADER_START") ||
    !/class=["'][^"']*\bse-viewer\b/.test(rawContents)
  ) {
    return null;
  }
  const values: string[] = [];
  let sawViewer = false;
  const response = new HTMLRewriter()
    .on(".se-viewer", {
      element() {
        sawViewer = true;
      },
      text(chunk) {
        values.push(chunk.text);
      },
    })
    .transform(
      new Response(rawContents, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  await response.text();
  const text = normalizeWhitespace(values.join(" "));
  return sawViewer && text.length > 0 ? text : null;
}

export function parseKoreanDateRange(
  text: string,
  publishedAt: string,
): { start: string; end: string } | null {
  const compact = text.replace(/\s+/g, " ");
  const pattern =
    /(?:(\d{4})\s*[.년/-]\s*)?(\d{1,2})\s*[.월/-]\s*(\d{1,2})\s*일?(?:\s*\([^)]*\))?(?:\s*(오전|오후))?\s*(\d{1,2})?(?::(\d{2}))?\s*(?:~|～|부터|–|—)\s*(?:(\d{4})\s*[.년/-]\s*)?(\d{1,2})\s*[.월/-]\s*(\d{1,2})\s*일?(?:\s*\([^)]*\))?(?:\s*(오전|오후))?\s*(\d{1,2})?(?::(\d{2}))?/;
  const match = compact.match(pattern);
  if (!match) return null;
  const publishedYear = new Date(publishedAt).getUTCFullYear();
  const startYear = Number(match[1] ?? publishedYear);
  const startMonth = Number(match[2]);
  const startDay = Number(match[3]);
  const endMonth = Number(match[8]);
  const endDay = Number(match[9]);
  const endYear = Number(match[7] ?? (endMonth < startMonth ? startYear + 1 : startYear));
  const startHour = koreanHour(match[4], match[5], 5);
  const endHour = koreanHour(match[10], match[11], 4);
  const startMinute = Number(match[6] ?? 0);
  const endMinute = Number(match[12] ?? (match[11] ? 0 : 59));
  const start = zonedKstTimestamp(startYear, startMonth, startDay, startHour, startMinute);
  const end = zonedKstTimestamp(endYear, endMonth, endDay, endHour, endMinute);
  return Date.parse(end) > Date.parse(start) ? { start, end } : null;
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

async function readGuardedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`naver_http_${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("naver_content_type");
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("naver_response_oversize");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("naver_response_oversize");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("naver_malformed_json");
  }
}

function classifyEvent(text: string): ScheduleEvent["eventType"] | null {
  if (/(솔로\s*레이드|솔레)/.test(text)) {
    return /(중단|연장|재개|종료|일정\s*변경)/.test(text) ? "schedule_change" : "solo";
  }
  if (/(협동\s*작전|협작)/.test(text)) return "cooperation";
  if (/콜라보/.test(text)) return "collaboration";
  if (/(관리\s*키트\s*상자|보상\s*지급)/.test(text)) return "reward";
  return null;
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

async function parseNaverDetail(payload: unknown, boardId: 48 | 56, structuredOnly = false) {
  if (!isRecord(payload) || payload["code"] !== 200) throw new Error("naver_detail_schema_code");
  const content = payload["content"];
  if (!isRecord(content) || !isRecord(content["user"])) {
    throw new Error("naver_detail_schema_content");
  }
  const user = content["user"];
  const normalized = {
    ...content,
    user: { ...user, role: user["userRoleCode"] },
  };
  const item =
    (
      await parseNaverFeed({ code: 200, content: { feeds: [normalized] } }, boardId, {
        structuredJsonOnly: structuredOnly,
      })
    )[0] ?? null;
  return item;
}

function visit(value: unknown, output: string[]) {
  if (Array.isArray(value)) {
    for (const entry of value) visit(entry, output);
    return;
  }
  if (!isRecord(value)) return;
  if (value["@ctype"] === "textNode" && typeof value["value"] === "string") {
    output.push(value["value"]);
  }
  for (const entry of Object.values(value)) visit(entry, output);
}

function readFeedUrl(row: Record<string, unknown>, itemId: string) {
  const feedLink = row["feedLink"];
  if (isRecord(feedLink) && typeof feedLink["pc"] === "string") return feedLink["pc"];
  return `https://game.naver.com/lounge/nikke/board/detail/${itemId}`;
}

function parseNaverDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{14}$/.test(value)) throw new Error("naver_date");
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const hour = value.slice(8, 10);
  const minute = value.slice(10, 12);
  const second = value.slice(12, 14);
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`).toISOString();
}

function relevantExcerpt(text: string, keywords: readonly string[]) {
  const sentences = text.split(/(?<=[.!?。]|다\.)\s+|\n+/);
  const relevant = sentences.filter((sentence) => hasRelevantKeyword(sentence, keywords)).join(" ");
  return (relevant || text).slice(0, 600);
}

function hasRelevantKeyword(text: string, keywords: readonly string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function koreanHour(period: string | undefined, rawHour: string | undefined, fallback: number) {
  if (!rawHour) return fallback;
  let hour = Number(rawHour);
  if (period === "오후" && hour < 12) hour += 12;
  if (period === "오전" && hour === 12) hour = 0;
  return hour;
}

function zonedKstTimestamp(year: number, month: number, day: number, hour: number, minute: number) {
  const value = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}T${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:00+09:00`;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("parsed_schedule_date_invalid");
  return new Date(parsed).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
