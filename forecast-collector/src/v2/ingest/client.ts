import { readBoundedJson } from "../../../../shared/boundedHttp.ts";
import type { FetchLike } from "../../naver";
import { extractNoticeText } from "../../solo-sections";
import { type Stream, streams } from "./schedule";

export class IngestFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
  ) {
    super(code);
  }
}
function responseFailure(error: unknown): IngestFailure {
  if (error instanceof IngestFailure) return error;
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError")
      return new IngestFailure("timeout", true);
    if (error.message === "oversize_json" || error.message === "oversize_encoding")
      return new IngestFailure("invalid_response");
    if (error.message === "oversize") return new IngestFailure("oversize", true);
  }
  return new IngestFailure("transport", true);
}
export type Metadata = {
  feedId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new IngestFailure("schema");
  return value as Record<string, unknown>;
}
export function timestamp(value: unknown): string {
  if (typeof value !== "string") throw new IngestFailure("timestamp");
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}.000+09:00`
    : value.replace(/\+09$/, "+09:00");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+09:00$/.test(normalized))
    throw new IngestFailure("timestamp");
  const time = Date.parse(normalized);
  if (
    !Number.isFinite(time) ||
    new Date(time + 9 * 3_600_000).toISOString().slice(0, 19) !== normalized.slice(0, 19)
  )
    throw new IngestFailure("timestamp");
  return new Date(time).toISOString();
}
export function metadataUrl(stream: Stream, page: number): URL {
  if (!Number.isSafeInteger(page) || page < 0) throw new IngestFailure("cursor");
  const definition = streams[stream];
  const url = new URL(
    stream === "G"
      ? "https://comm-api.game.naver.com/nng_main/v1/community/lounge/nikke/feed"
      : "https://comm-api.game.naver.com/nng_main/v2/search/feeds",
  );
  url.search = new URLSearchParams(
    stream === "G"
      ? { boardId: "48", buffFilteringYN: "N", limit: "10", offset: String(page), order: "NEW" }
      : {
          loungeId: "nikke",
          boardId: String(definition.board),
          keyword: definition.keyword!,
          limit: "30",
          offset: String(page * 30),
          orderType: "LATEST",
          searchOption: stream === "B" ? "COMMUNITY_FEED_TITLE" : "COMMUNITY_FEED_TITLE_CONTENT",
        },
  ).toString();
  return url;
}
export function parseMetadata(payload: unknown, stream: Stream): Metadata[] {
  const root = record(payload);
  if (root["code"] !== 200) throw new IngestFailure("schema_code");
  const rows = record(root["content"])["feeds"];
  if (!Array.isArray(rows)) throw new IngestFailure("schema");
  if (rows.length > (stream === "G" ? 10 : 30)) throw new IngestFailure("page_size");
  const seen = new Set<string>();
  let previous = "";
  const result = rows.flatMap((raw) => {
    const row = record(raw);
    const feed = row["feed"] ? record(row["feed"]) : row;
    const board = row["board"] ? record(row["board"])["boardId"] : row["boardId"];
    const role = row["user"] ? record(row["user"])["userRoleCode"] : row["userRoleCode"];
    const lounge = row["lounge"] ? record(row["lounge"])["loungeId"] : undefined;
    if (lounge !== "nikke" || board !== streams[stream].board || typeof role !== "string")
      throw new IngestFailure("identity");
    const feedId = String(feed["feedId"]);
    if (!/^[1-9]\d{0,19}$/.test(feedId) || seen.has(feedId) || typeof feed["title"] !== "string")
      throw new IngestFailure("feed");
    seen.add(feedId);
    const createdAt = timestamp(feed["createdDate"]);
    const updatedAt = timestamp(feed["updatedDate"]);
    if (updatedAt < createdAt || (previous && createdAt > previous))
      throw new IngestFailure("ordering");
    previous = createdAt;
    return role === "game_manager" ? [{ feedId, title: feed["title"], createdAt, updatedAt }] : [];
  });
  Object.defineProperty(result, "sourceCount", { value: rows.length });
  return result;
}
export async function fetchMetadata(stream: Stream, page: number, fetcher: FetchLike = fetch) {
  try {
    const response = await fetcher(metadataUrl(stream, page), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new IngestFailure(
        `http_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    return parseMetadata(await readBoundedJson(response, 2_000_000, "oversize"), stream);
  } catch (error) {
    throw responseFailure(error);
  }
}

export async function fetchDetail(stream: Stream, expected: Metadata, fetcher: FetchLike = fetch) {
  const url = new URL(
    `https://comm-api.game.naver.com/nng_main/v1/community/lounge/nikke/feed/${expected.feedId}`,
  );
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok)
      throw new IngestFailure(
        `http_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    const root = record(await readBoundedJson(response, 2_000_000, "oversize"));
    const content = record(root["content"]);
    const [identity] = parseMetadata({ code: root["code"], content: { feeds: [content] } }, stream);
    if (!identity) throw new IngestFailure("identity");
    if (
      identity.feedId !== expected.feedId ||
      identity.createdAt !== expected.createdAt ||
      identity.updatedAt !== expected.updatedAt
    )
      throw new IngestFailure("detail_drift");
    const body = record(content["feed"])["contents"];
    if (typeof body !== "string" || !body.trim()) throw new IngestFailure("detail_body");
    return { ...identity, bodyText: extractNoticeText(body).effective };
  } catch (error) {
    throw responseFailure(error);
  }
}
