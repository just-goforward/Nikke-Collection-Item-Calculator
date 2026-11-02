import type { FetchLike } from "../../../naver";
import { type Stream, streams } from "../schedule";

// Synthetic Naver payloads in the two observed wire formats:
// search rows use `yyyy-MM-ddTHH:mm:ss.SSS+09`, the board list and detail use `yyyyMMddHHmmss`.
export type Post = {
  feedId: number;
  created: string;
  updated?: string;
  title?: string;
  body?: string;
};

/** KST wall-clock `yyyy-MM-ddTHH:mm:ss` → ISO instant (independent of the code under test). */
export const iso = (kst: string) => new Date(`${kst}+09:00`).toISOString();
export const searchTime = (kst: string) => `${kst}.000+09`;
const listTime = (kst: string) => kst.replace(/[-:T]/g, "");

export function metadataRow(stream: Stream, post: Post, overrides: Record<string, unknown> = {}) {
  const format = stream === "G" ? listTime : searchTime;
  return {
    feedId: post.feedId,
    title: post.title ?? `notice ${post.feedId}`,
    createdDate: format(post.created),
    updatedDate: format(post.updated ?? post.created),
    boardId: streams[stream].board,
    userRoleCode: "game_manager",
    lounge: { loungeId: "nikke" },
    ...overrides,
  };
}
/** Unsanitized live row shape (plan §7C F7): nested feed/board/user/lounge objects. */
export function liveRow(stream: Stream, post: Post, role = "game_manager") {
  const format = stream === "G" ? listTime : searchTime;
  return {
    feed: {
      feedId: post.feedId,
      title: post.title ?? `notice ${post.feedId}`,
      createdDate: format(post.created),
      updatedDate: format(post.updated ?? post.created),
    },
    board: { boardId: streams[stream].board },
    user: { userRoleCode: role },
    lounge: { loungeId: "nikke" },
  };
}
export const pagePayload = (rows: unknown[]) => ({ code: 200, content: { feeds: rows } });
export const page = (stream: Stream, posts: Post[]) =>
  pagePayload(posts.map((post) => metadataRow(stream, post)));

export function detailPayload(stream: Stream, post: Post) {
  return {
    code: 200,
    content: {
      feed: {
        feedId: post.feedId,
        title: post.title ?? `notice ${post.feedId}`,
        createdDate: listTime(post.created),
        updatedDate: listTime(post.updated ?? post.created),
        contents: `<p>${post.body ?? `body ${post.feedId}`}</p>`,
      },
      board: { boardId: streams[stream].board },
      user: { userRoleCode: "game_manager" },
      lounge: { loungeId: "nikke" },
    },
  };
}

/** Metadata the ingest client should derive for a post (expected values built independently). */
export const expectedMetadata = (post: Post) => ({
  feedId: String(post.feedId),
  title: post.title ?? `notice ${post.feedId}`,
  createdAt: iso(post.created),
  updatedAt: iso(post.updated ?? post.created),
});

type Reply = unknown | (() => Response | Promise<Response>);
export type Call =
  | { kind: "metadata"; stream: Stream; page: number; url: URL }
  | { kind: "detail"; feedId: string; url: URL };

function streamOf(url: URL): Stream {
  if (url.pathname.endsWith("/lounge/nikke/feed")) return "G";
  const board = Number(url.searchParams.get("boardId"));
  const keyword = url.searchParams.get("keyword");
  const match = (Object.keys(streams) as Stream[]).find(
    (stream) => streams[stream].board === board && streams[stream].keyword === keyword,
  );
  if (!match) throw new Error(`fake_naver_unknown_stream:${url}`);
  return match;
}

/**
 * Offline Naver: replies are queued per metadata page or detail ID; the last
 * queued reply is sticky. Unrouted requests answer HTTP 404.
 */
export class FakeNaver {
  readonly calls: Call[] = [];
  private readonly replies = new Map<string, Reply[]>();

  page(stream: Stream, index: number, ...replies: Reply[]) {
    this.replies.set(`m:${stream}:${index}`, replies);
    return this;
  }
  detail(feedId: number | string, ...replies: Reply[]) {
    this.replies.set(`d:${feedId}`, replies);
    return this;
  }
  metadataCalls(stream?: Stream) {
    return this.calls.filter(
      (call): call is Extract<Call, { kind: "metadata" }> =>
        call.kind === "metadata" && (!stream || call.stream === stream),
    );
  }
  detailCalls() {
    return this.calls
      .filter((call): call is Extract<Call, { kind: "detail" }> => call.kind === "detail")
      .map((call) => call.feedId);
  }

  readonly fetcher: FetchLike = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const detail = /\/lounge\/nikke\/feed\/(\d+)$/.exec(url.pathname)?.[1];
    let key: string;
    if (detail) {
      this.calls.push({ kind: "detail", feedId: detail, url });
      key = `d:${detail}`;
    } else {
      const stream = streamOf(url);
      const offset = Number(url.searchParams.get("offset"));
      const index = stream === "G" ? offset : offset / 30;
      this.calls.push({ kind: "metadata", stream, page: index, url });
      key = `m:${stream}:${index}`;
    }
    const queue = this.replies.get(key);
    if (!queue?.length) return new Response("not routed", { status: 404 });
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    return typeof reply === "function"
      ? (reply as () => Response | Promise<Response>)()
      : Response.json(reply);
  };
}

export const status = (code: number) => () => new Response("", { status: code });
export const timeout = () => () =>
  Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
export const transportError = () => () => Promise.reject(new TypeError("network connection lost"));
export const malformedJson = () => () => new Response('{"code":200,"content":');
export const invalidUtf8 = () => () => new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
export const declaredOversize = () => () =>
  new Response("{}", { headers: { "content-length": "2000001" } });
/** Streams 2,000,001 bytes without a content-length header. */
export const streamedOversize = () => () => {
  const chunk = new Uint8Array(500_001).fill(0x20);
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 4) controller.close();
        else {
          controller.enqueue(chunk);
          sent++;
        }
      },
    }),
  );
};
