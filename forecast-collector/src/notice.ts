import { readBoundedText } from "../../shared/boundedHttp";
import { type FetchLike, parseNaverFeed } from "./naver";
import type { ProfileCounts } from "./profile";
import { extractNoticeText, type NoticeText, noticeTexts } from "./solo-sections";

const DETAIL_URL = "https://comm-api.game.naver.com/nng_main/v1/community/lounge/nikke/feed/";
export const NOTICE_MAX_BYTES = 2_000_000;
export const NOTICE_TIMEOUT_MS = 10_000;

// One reservation buys exactly one request. Retries belong to the durable queue,
// not this transport; redirects must not spend unaccounted requests.
export async function fetchNotice(
  board: 11 | 48 | 56,
  itemId: string,
  fetcher: FetchLike = fetch,
  counts?: ProfileCounts,
) {
  if (!/^\d{1,20}$/.test(itemId)) throw new Error("naver_item_id");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("naver_timeout"));
    }, NOTICE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        let response: Response;
        try {
          response = await fetcher(`${DETAIL_URL}${itemId}`, {
            headers: {
              accept: "application/json",
              origin: "https://game.naver.com",
              referer: "https://game.naver.com/",
              "user-agent": "collection-kit-forecast-collector/1.0",
            },
            // workerd rejects redirect:"error" with a TypeError; refuse redirects manually.
            redirect: "manual",
            signal: controller.signal,
          });
        } catch {
          throw new Error(controller.signal.aborted ? "naver_timeout" : "naver_network");
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new Error("naver_redirect");
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`naver_http_${response.status}`);
        }
        if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
          await response.body?.cancel();
          throw new Error("naver_content_type");
        }
        // Keep the fetch's abort signal live through streaming and parsing.
        const text = await readBoundedText(response, NOTICE_MAX_BYTES, "naver_response_too_large");
        if (counts) counts.bodyBytes += new TextEncoder().encode(text).byteLength;
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error("naver_malformed_json");
        }
        return await parseNoticeDetail(payload, board, itemId);
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Frozen Actions adapter parity: scripts/forecast-naver-action.ts. Keep that
// legacy file untouched; fixture tests compare both implementations byte-for-byte.
export async function parseNoticeDetail(
  payload: unknown,
  boardId: 11 | 48 | 56,
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
    feed,
    user: { ...user, role: user["userRoleCode"] },
  };
  const extracted = extractNoticeText(feed["contents"]);
  const item =
    (
      await parseNaverFeed({ code: 200, content: { feeds: [normalized] } }, boardId, {
        structuredJsonOnly: true,
        parsedContents: { value: normalizeSmartEditorContents(feed["contents"], extracted) },
      })
    )[0] ?? null;
  if (item) noticeTexts.set(item, extracted);
  return item;
}

function normalizeSmartEditorContents(rawContents: string, extracted: NoticeText) {
  if (extracted.parsed !== undefined) return extracted.parsed;
  if (
    !rawContents.includes("SE_DOC_HEADER_START") ||
    !/<div\b[^>]*class=["'][^"']*\bse-viewer\b[^>]*>/i.test(rawContents)
  ) {
    throw new Error("naver_unstructured_body");
  }
  const text = extracted.legacyText;
  if (!text) throw new Error("naver_unstructured_body");
  return { document: { components: [{ "@ctype": "textNode", value: text }] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
