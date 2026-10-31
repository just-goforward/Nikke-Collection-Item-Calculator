import { board11MetadataEligible } from "./board11-policy";
import { sha256Hex } from "./crypto";
import type { SoloContext } from "./solo-contracts";
import { judgeSolo, judgments } from "./solo-judgment";
import { noticeTexts } from "./solo-sections";
import type { NormalizedSourceItem, ScheduleEvent, SourceKind } from "./types";

const BOARD_KEYWORDS: Record<11 | 48 | 56, readonly string[]> = {
  11: ["솔로 레이드", "솔로레이드", "보상", "관리 키트 상자"],
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

export async function parseNaverFeed(
  payload: unknown,
  boardId: 11 | 48 | 56,
  // parsedContents is the already-parsed contents of a single-article detail payload;
  // it applies to every feed row, so pass it only for one-article detail responses.
  options: { structuredJsonOnly?: boolean; parsedContents?: { value: unknown } } = {},
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
    if (
      boardId === 11 &&
      !board11MetadataEligible(
        title,
        user["role"] === "game_manager" || user["userRoleCode"] === "game_manager",
      )
    )
      continue;
    const extracted = await extractSmartEditorText(
      rawContents,
      options.structuredJsonOnly === true,
      options.parsedContents,
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
  context: SoloContext = {},
): Promise<ScheduleEvent[]> {
  const events: ScheduleEvent[] = [];
  for (const item of items) {
    if (noticeTexts.has(item)) {
      const judged = judgeSolo(item, parseKoreanDateRange, context);
      if (judged) {
        judgments.set(item, judged);
        events.push(...judged.flatMap((judgment) => (judgment.event ? [judgment.event] : [])));
        continue;
      }
    }
    const text = item.normalizedText;
    const schedule = parseKoreanDateRange(text, item.publishedAt);
    const eventType = classifyEvent(text);
    const manualReview =
      !item.structured ||
      !item.official ||
      /점검\s*완료\s*후/.test(text) ||
      ((eventType === "solo" || eventType === "schedule_change") && /재오픈/.test(text)) ||
      (/(중단|연장|재개|일정\s*변경)/.test(text) && schedule === null);
    if (!eventType) continue;
    const eventId = `${item.source}:${item.itemId}:${eventType}`;
    const reason = scheduleReviewReason(item, manualReview);
    events.push({
      eventId,
      eventType,
      sourceItem: item,
      startsAt: schedule?.start ?? null,
      endsAt: schedule?.end ?? null,
      scheduleStatus: "confirmed",
      manualReview,
      reason,
    });
  }
  return events;
}

function scheduleReviewReason(
  item: NormalizedSourceItem,
  manualReview: boolean,
): ScheduleEvent["reason"] {
  if (!manualReview) return null;
  if (!item.official) return "not_official_manager";
  if (!item.structured) return "unstructured_body";
  return "ambiguous_schedule_change";
}

async function extractSmartEditorText(
  rawContents: string,
  structuredJsonOnly = false,
  parsedContents?: { value: unknown },
): Promise<{
  text: string;
  structured: boolean;
}> {
  try {
    const parsed: unknown = parsedContents ? parsedContents.value : JSON.parse(rawContents);
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

function classifyEvent(text: string): ScheduleEvent["eventType"] | null {
  if (/(솔로\s*레이드|솔레)/.test(text)) {
    return text
      .split(/[.!?。！？\r\n]+/)
      .some(
        (sentence) =>
          /(솔로\s*레이드|솔레)/.test(sentence) &&
          /(중단|연장|재개|재오픈|종료|일정\s*변경)/.test(sentence),
      )
      ? "schedule_change"
      : "solo";
  }
  if (/(협동\s*작전|협작)/.test(text)) return "cooperation";
  if (/콜라보/.test(text)) return "collaboration";
  if (/(관리\s*키트\s*상자|보상\s*지급)/.test(text)) return "reward";
  return null;
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
