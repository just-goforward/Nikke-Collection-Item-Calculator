import { expect, it } from "vitest";
import { readBoundedText } from "../../shared/boundedHttp";
import fixture from "../fixtures/official-solo-history/8060044.json";
import { parseNaverFeed, parseScheduleEvents } from "./naver";
import { fetchNotice, NOTICE_MAX_BYTES, parseNoticeDetail } from "./notice";
import { buildNoticeCandidate, noticeErrorCode } from "./notice-processing";

// Retained d336e9c normalization, including the synthetic JSON round trip.
// parseNaverFeed without parsedContents retains the original raw-string extraction
// path (JSON.parse, visit, HTMLRewriter fallback); the reference never opts into
// the optimized parsed-representation path.
function oldNormalize(rawContents: string) {
  try {
    JSON.parse(rawContents);
    return rawContents;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (
    !rawContents.includes("SE_DOC_HEADER_START") ||
    !/<div\b[^>]*class=["'][^"']*\bse-viewer\b[^>]*>/i.test(rawContents)
  ) {
    throw new Error("naver_unstructured_body");
  }
  const text = oldDecode(
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

function oldDecode(value: string) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Retained d336e9c parseNoticeDetail.
async function oldParse(payload: unknown, boardId: 48 | 56, expectedItemId: string) {
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
    feed: { ...feed, contents: oldNormalize(feed["contents"]) },
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

async function outputs(parse: () => ReturnType<typeof parseNoticeDetail>) {
  try {
    const item = await parse();
    const events = await parseScheduleEvents(item ? [item] : []);
    const candidate = await buildNoticeCandidate(
      [],
      item
        ? events.map((event) => ({
            source: "naver-board-56" as const,
            itemId: item.itemId,
            outcome: "processed" as const,
            item,
            event,
          }))
        : [],
      Date.parse("2026-08-20T12:00:00Z"),
      1,
    );
    return { json: JSON.stringify({ item, events, candidate }) };
  } catch (error) {
    return { error: noticeErrorCode(error) };
  }
}

const structured = (value: string) =>
  JSON.stringify({ document: { components: [{ "@ctype": "textNode", value }] } });
const schedule = "솔로 레이드 2026년 8월 20일 12:00 ~ 8월 27일 4:59";

it.each([
  ["valid JSON", structured(`${schedule}\n중첩 "인용" \\ & 한글`)],
  ["empty structured doc", '{"document":{"components":[]}}'],
  ["empty text node", structured("")],
  ["null JSON", "null"],
  ["primitive JSON", '"솔로 레이드"'],
  ["numeric primitive JSON", "42"],
  ["boolean primitive JSON", "true"],
  [
    "literal less-than",
    `<!-- SE_DOC_HEADER_START --><div class="se-viewer">${schedule}</div> tail <`,
  ],
  [
    "nested template",
    `<!-- SE_DOC_HEADER_START --><div class="se-viewer"><template><template>hidden</template>legacy visible</template>${schedule}</div>`,
  ],
  ["malformed doc", '{"document":{"components":'],
  ["unrecognized HTML", `<p>${schedule}</p>`],
  ["empty recognized HTML", '<!-- SE_DOC_HEADER_START --><div class="se-viewer"></div>'],
  [
    "HTML with entities",
    `<!-- SE_DOC_HEADER_START --><div class="se-viewer"><p>${schedule}</p>
    <script>bad</script><style>bad</style><template>bad</template>
    <p>&amp; &apos; &gt; &lt; &nbsp; &quot; &#39; &#x1f600; &#55296; &#1114112;
    &unknown; &AMP;<br>한글</p></div>`,
  ],
])(
  "%s preserves all item, event and candidate bytes or the error code",
  async (_name, contents) => {
    const payload = structuredClone(fixture);
    payload.content.feed.contents = contents;
    const expected = await outputs(() => oldParse(payload, 56, "8060044"));
    expect(await outputs(() => parseNoticeDetail(payload, 56, "8060044"))).toEqual(expected);
  },
);

it.each([-1, 0, 1])("preserves the UTF-8 response size boundary at limit %+i", async (delta) => {
  const payload = structuredClone(fixture);
  payload.content.feed.contents = structured(`${schedule} 한글😀`);
  const base = JSON.stringify({ ...payload, padding: "" });
  const padding = " ".repeat(NOTICE_MAX_BYTES + delta - new TextEncoder().encode(base).length);
  const body = JSON.stringify({ ...payload, padding });
  expect(new TextEncoder().encode(body).length).toBe(NOTICE_MAX_BYTES + delta);
  const response = () => new Response(body, { headers: { "content-type": "application/json" } });
  // Retained successful-200 application/json transport path from d336e9c.
  const expected = await outputs(async () => {
    const text = await readBoundedText(response(), NOTICE_MAX_BYTES, "naver_response_too_large");
    return oldParse(JSON.parse(text), 56, "8060044");
  });
  expect(await outputs(() => fetchNotice(56, "8060044", async () => response()))).toEqual(expected);
  if (delta > 0) expect(expected).toEqual({ error: "naver_response_too_large" });
  else expect(expected).toHaveProperty("json");
});
