import { parseNaverFeed } from "./naver";
import { extractNoticeText, type NoticeText, noticeTexts } from "./solo-sections";

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
