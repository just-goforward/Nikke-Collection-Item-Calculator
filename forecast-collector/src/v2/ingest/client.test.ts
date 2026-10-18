import { describe, expect, it } from "vitest";
import { fetchDetail, fetchMetadata, metadataUrl, parseMetadata, timestamp } from "./client";
import { budgetGameDay, type Stream, scheduledStream, streams, v2Mode } from "./schedule";
import {
  detailPath,
  fixture,
  fixturePaths,
  fixtureRecord,
  hasFixture,
  loungeFromRequestUrl,
  rawFixture,
} from "./test-support/fixtures";
import {
  declaredOversize,
  detailPayload,
  expectedMetadata,
  FakeNaver,
  invalidUtf8,
  iso,
  liveRow,
  malformedJson,
  metadataRow,
  type Post,
  page,
  pagePayload,
  status,
  streamedOversize,
  timeout,
  transportError,
} from "./test-support/naver";

const searchStreams = [
  "A",
  "B",
  "C-open",
  "C-reopen",
  "D",
  "E",
  "F",
] as const satisfies readonly Stream[];
const manifestSearch: Record<(typeof searchStreams)[number], string> = {
  A: "search-A-0.json",
  B: "search-B-0.json",
  "C-open": "search-C-open-0.json",
  "C-reopen": "search-C-reopen-0.json",
  D: "search-D-0.json",
  E: "search-E-0.json",
  F: "search-F-0.json",
};
const post: Post = { feedId: 9000001, created: "2026-10-18T17:00:00" };

describe("T02 request parameters", () => {
  it.each(searchStreams)(
    "%s searches one board, newest first, with the captured query",
    (stream) => {
      const captured = new URL(fixtureRecord(manifestSearch[stream]).url);
      for (const index of [0, 1, 3]) {
        const url = metadataUrl(stream, index);
        expect(url.origin + url.pathname).toBe(captured.origin + captured.pathname);
        expect(url.searchParams.getAll("boardId")).toEqual([String(streams[stream].board)]);
        for (const name of ["loungeId", "boardId", "keyword", "searchOption", "orderType"])
          expect(url.searchParams.getAll(name), name).toEqual(captured.searchParams.getAll(name));
        expect(url.searchParams.get("orderType")).toBe("LATEST");
        expect(url.searchParams.get("searchOption")).toBe(
          stream === "B" ? "COMMUNITY_FEED_TITLE" : "COMMUNITY_FEED_TITLE_CONTENT",
        );
        // Search offsets are row offsets with page size 30 (A6).
        expect(url.searchParams.get("limit")).toBe("30");
        expect(url.searchParams.get("offset")).toBe(String(index * 30));
      }
    },
  );

  it("G lists board 48 by page index with page size 10, exactly as captured", () => {
    for (const index of [0, 6, 12]) {
      const captured = new URL(fixtureRecord(`board48-limit10-${index}.json`).url);
      const url = metadataUrl("G", index);
      expect(url.origin + url.pathname).toBe(captured.origin + captured.pathname);
      expect([...url.searchParams].sort()).toEqual([...captured.searchParams].sort());
      expect(url.searchParams.get("offset")).toBe(String(index));
      expect(url.searchParams.get("limit")).toBe("10");
    }
  });

  // Reflect.apply lets the untyped `undefined` cursor reach the runtime check.
  it.each([-1, 1.5, Number.NaN, undefined])("rejects a missing or invalid cursor %s", (index) => {
    for (const stream of ["A", "G"])
      expect(() => Reflect.apply(metadataUrl, undefined, [stream, index])).toThrow(
        expect.objectContaining({ code: "cursor" }),
      );
  });

  it("requests the URL it builds and nothing else", async () => {
    const naver = new FakeNaver().page("B", 2, page("B", [post]));
    await fetchMetadata("B", 2, naver.fetcher);
    expect(naver.calls.map((call) => call.url.href)).toEqual([metadataUrl("B", 2).href]);
  });
});

describe("T02 timestamp normalization", () => {
  it.each([
    ["2026-10-18T17:00:00.000+09", "2026-10-18T08:00:00.000Z"],
    ["2026-10-18T17:00:00+09", "2026-10-18T08:00:00.000Z"],
    ["20261018170000", "2026-10-18T08:00:00.000Z"],
    ["20241231235959", "2024-12-31T14:59:59.000Z"],
    ["20260101050000", "2025-12-31T20:00:00.000Z"],
    ["2024-02-29T00:00:00.000+09", "2024-02-28T15:00:00.000Z"],
  ])("%s → %s", (input, expected) => {
    expect(timestamp(input)).toBe(expected);
  });

  it.each([
    "2026-10-18T17:00:00.000Z",
    "2026-10-18T17:00:00.000+0900",
    "2026-10-18T17:00:00.000",
    "2026-10-18 17:00:00",
    "20261018",
    "202610181700000",
    "20261318170000",
    "20260230170000",
    "20261018250000",
    "2025-02-29T00:00:00.000+09",
    "",
    20261018170000,
    null,
  ])("rejects %s", (input) => {
    expect(() => timestamp(input)).toThrow(expect.objectContaining({ code: "timestamp" }));
  });

  it("normalizes every captured search and list timestamp to its KST wall clock", async () => {
    const paths = fixturePaths(/^(search-.*|board48-limit10-\d+)\.json$/);
    expect(paths.length).toBeGreaterThanOrEqual(21);
    for (const path of paths) {
      for (const row of (await rawFixture(path)).content.feeds ?? []) {
        for (const field of ["createdDate", "updatedDate"]) {
          const raw = String(row[field]);
          const digits = raw.replace(/\D/g, "").slice(0, 14);
          const kstWall = new Date(Date.parse(timestamp(raw)) + 9 * 3_600_000)
            .toISOString()
            .replace(/\D/g, "")
            .slice(0, 14);
          expect(kstWall, `${path} ${row["feedId"]} ${field}`).toBe(digits);
        }
      }
    }
  });
});

describe("T02 response validation", () => {
  it("the sanitized fixtures need the lounge adapter (identity is checked, not assumed)", async () => {
    const raw = await rawFixture("search-A-0.json");
    expect(() => parseMetadata(raw, "A")).toThrow(expect.objectContaining({ code: "identity" }));
    expect(loungeFromRequestUrl(fixtureRecord("search-A-0.json").url)).toBe("nikke");
    expect(loungeFromRequestUrl(fixtureRecord(detailPath(6848849)).url)).toBe("nikke");
    expect(loungeFromRequestUrl(fixtureRecord("board48-limit10-6.json").url)).toBe("nikke");
  });

  it.each(searchStreams)(
    "parses the captured %s search (first 30 rows) newest first",
    async (stream) => {
      const payload = await fixture(manifestSearch[stream]);
      const rows = (payload.content.feeds ?? []).slice(0, 30);
      const parsed = parseMetadata(pagePayload(rows), stream);
      expect(parsed.map((row) => row.feedId)).toEqual(rows.map((row) => String(row["feedId"])));
      const created = parsed.map((row) => row.createdAt);
      expect(created).toEqual([...created].sort().reverse());
    },
  );

  it("parses every captured 10-row G page and rejects the 30-row capture", async () => {
    for (const path of fixturePaths(/^board48-limit10-\d+\.json$/))
      expect(parseMetadata(await fixture(path), "G").length, path).toBeLessThanOrEqual(10);
    const thirty = await fixture("board48-0.json");
    expect(thirty.content.feeds).toHaveLength(30);
    expect(() => parseMetadata(thirty, "G")).toThrow(
      expect.objectContaining({ code: "page_size" }),
    );
  });

  it("accepts the unsanitized live row shape with the lounge from lounge.loungeId (F7)", () => {
    const row = {
      feed: {
        feedId: 1,
        title: "t",
        createdDate: "20261018170000",
        updatedDate: "20261018170000",
      },
      board: { boardId: 48 },
      user: { userRoleCode: "game_manager" },
      lounge: { loungeId: "nikke" },
    };
    expect(parseMetadata(pagePayload([row]), "G")).toEqual([
      {
        feedId: "1",
        title: "t",
        createdAt: iso("2026-10-18T17:00:00"),
        updatedAt: iso("2026-10-18T17:00:00"),
      },
    ]);
    for (const lounge of [{ loungeId: "other" }, {}])
      expect(() => parseMetadata(pagePayload([{ ...row, lounge }]), "G")).toThrow(
        expect.objectContaining({ code: "identity" }),
      );
  });

  it("skips non-manager rows without failing the page and still validates them (F7)", () => {
    const a = { feedId: 3, created: "2026-10-18T17:00:00" };
    const member = { feedId: 2, created: "2026-10-18T16:00:00" };
    const b = { feedId: 1, created: "2026-10-18T15:00:00" };
    for (const stream of ["A", "G"] as const) {
      const live = [liveRow(stream, a), liveRow(stream, member, "member"), liveRow(stream, b)];
      expect(parseMetadata(pagePayload(live), stream)).toEqual([
        expectedMetadata(a),
        expectedMetadata(b),
      ]);
      const flat = [
        metadataRow(stream, a),
        metadataRow(stream, member, { userRoleCode: "member" }),
        metadataRow(stream, b),
      ];
      expect(parseMetadata(pagePayload(flat), stream)).toEqual([
        expectedMetadata(a),
        expectedMetadata(b),
      ]);
      // A skipped row is still part of the page: ordering, board and lounge are checked.
      const misordered = [liveRow(stream, b), liveRow(stream, a, "member")];
      expect(() => parseMetadata(pagePayload(misordered), stream)).toThrow(
        expect.objectContaining({ code: "ordering" }),
      );
      const foreign = { ...liveRow(stream, member, "member"), board: { boardId: 1 } };
      expect(() => parseMetadata(pagePayload([liveRow(stream, a), foreign]), stream)).toThrow(
        expect.objectContaining({ code: "identity" }),
      );
    }
    const onlyMembers = parseMetadata(
      pagePayload([liveRow("A", member, "member"), liveRow("A", b, "player")]),
      "A",
    );
    expect(onlyMembers).toEqual([]);
  });

  it.each<[string, Stream, Record<string, unknown>, string]>([
    ["wrong board", "A", { boardId: 48 }, "identity"],
    ["search board for another stream", "C-open", { boardId: 11 }, "identity"],
    ["G row from another board", "G", { boardId: 56 }, "identity"],
    ["missing role", "A", { userRoleCode: undefined }, "identity"],
    ["foreign lounge", "A", { lounge: { loungeId: "other" } }, "identity"],
    ["lounge object without an id", "A", { lounge: {} }, "identity"],
    ["missing lounge", "A", { lounge: undefined }, "identity"],
    ["non-numeric feed id", "A", { feedId: "12a" }, "feed"],
    ["zero feed id", "A", { feedId: 0 }, "feed"],
    ["missing title", "A", { title: undefined }, "feed"],
    ["updated before created", "A", { updatedDate: "2026-10-18T16:59:59.000+09" }, "ordering"],
  ])("rejects %s", (_name, stream, override, code) => {
    const row = metadataRow(stream, post, override);
    for (const key of Object.keys(override))
      if (override[key] === undefined) delete (row as Record<string, unknown>)[key];
    expect(() => parseMetadata(pagePayload([row]), stream)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("rejects envelopes, oversized, duplicate and out-of-order pages; an empty page is valid (F14)", () => {
    const rows = (n: number, stream: Stream) =>
      Array.from({ length: n }, (_, i) =>
        metadataRow(stream, {
          feedId: 1000 - i,
          created: `2026-10-18T1${Math.floor(i / 60) % 10}:${String(59 - (i % 60)).padStart(2, "0")}:00`,
        }),
      );
    expect(() => parseMetadata({ code: 500, content: { feeds: rows(1, "A") } }, "A")).toThrow(
      expect.objectContaining({ code: "schema_code" }),
    );
    expect(() => parseMetadata(null, "A")).toThrow(expect.objectContaining({ code: "schema" }));
    expect(() => parseMetadata({ code: 200 }, "A")).toThrow(
      expect.objectContaining({ code: "schema" }),
    );
    expect(parseMetadata(pagePayload([]), "A")).toEqual([]);
    expect(parseMetadata(pagePayload([]), "G")).toEqual([]);
    expect(parseMetadata(pagePayload(rows(30, "A")), "A")).toHaveLength(30);
    expect(() => parseMetadata(pagePayload(rows(31, "A")), "A")).toThrow(
      expect.objectContaining({ code: "page_size" }),
    );
    expect(parseMetadata(pagePayload(rows(10, "G")), "G")).toHaveLength(10);
    expect(() => parseMetadata(pagePayload(rows(11, "G")), "G")).toThrow(
      expect.objectContaining({ code: "page_size" }),
    );
    const duplicate = rows(2, "A");
    duplicate[1] = { ...duplicate[1]!, feedId: duplicate[0]!.feedId };
    expect(() => parseMetadata(pagePayload(duplicate), "A")).toThrow(
      expect.objectContaining({ code: "feed" }),
    );
    expect(() => parseMetadata(pagePayload(rows(2, "A").reverse()), "A")).toThrow(
      expect.objectContaining({ code: "ordering" }),
    );
  });

  it("keeps equal-timestamp rows (ties are legal ordering)", () => {
    const tie = [9, 8, 7].map((feedId) =>
      metadataRow("A", { feedId, created: "2026-10-18T17:00:00" }),
    );
    expect(parseMetadata(pagePayload(tie), "A").map((row) => row.feedId)).toEqual(["9", "8", "7"]);
  });
});

describe("T02 transport failures are typed", () => {
  it.each<[string, () => () => Response | Promise<Response>, string, boolean]>([
    ["400", () => status(400), "http_400", false],
    ["404", () => status(404), "http_404", false],
    ["429", () => status(429), "http_429", true],
    ["500", () => status(500), "http_500", true],
    ["503", () => status(503), "http_503", true],
    ["timeout", timeout, "timeout", true],
    ["transport", transportError, "transport", true],
    ["declared oversize", declaredOversize, "oversize", true],
    ["streamed oversize", streamedOversize, "oversize", true],
    ["malformed JSON", malformedJson, "invalid_response", false],
    ["invalid UTF-8", invalidUtf8, "invalid_response", false],
  ])("metadata and detail %s → typed failure", async (_name, reply, code, retryable) => {
    const naver = new FakeNaver().page("A", 0, reply()).detail(post.feedId, reply());
    await expect(fetchMetadata("A", 0, naver.fetcher)).rejects.toMatchObject({ code, retryable });
    await expect(fetchDetail("A", expectedMetadata(post), naver.fetcher)).rejects.toMatchObject({
      code,
      retryable,
    });
  });

  it("accepts a response of exactly 2,000,000 bytes", async () => {
    const body = JSON.stringify(page("A", [post]));
    const padded = body + " ".repeat(2_000_000 - new TextEncoder().encode(body).byteLength);
    const parsed = await fetchMetadata("A", 0, async () => new Response(padded));
    expect(parsed).toEqual([expectedMetadata(post)]);
  });
});

describe("T02 detail identity", () => {
  it("returns the effective notice text for a matching detail", async () => {
    const naver = new FakeNaver().detail(
      post.feedId,
      detailPayload("A", { ...post, body: "본문 <b>텍스트</b>" }),
    );
    const detail = await fetchDetail("A", expectedMetadata(post), naver.fetcher);
    expect(detail).toMatchObject({ ...expectedMetadata(post), bodyText: "본문 텍스트" });
    expect(naver.detailCalls()).toEqual([String(post.feedId)]);
    expect(naver.calls[0]?.url.href).toBe(
      `https://comm-api.game.naver.com/nng_main/v1/community/lounge/nikke/feed/${post.feedId}`,
    );
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
    ["another feed", { feedId: 9000002 }, {}, "detail_drift"],
    ["an edit since the scan", { updatedDate: "20261018180000" }, {}, "detail_drift"],
    ["another creation time", { createdDate: "20261018165959" }, {}, "detail_drift"],
    ["another board", {}, { board: { boardId: 56 } }, "identity"],
    ["a member author", {}, { user: { userRoleCode: "member" } }, "identity"],
    ["a foreign lounge", {}, { lounge: { loungeId: "other" } }, "identity"],
    ["an empty body", { contents: "  " }, {}, "detail_body"],
  ])("fails closed for %s", async (_name, feed, content, code) => {
    const payload = detailPayload("A", post);
    Object.assign(payload.content.feed, feed);
    Object.assign(payload.content, content);
    await expect(
      fetchDetail("A", expectedMetadata(post), async () => Response.json(payload)),
    ).rejects.toMatchObject({ code });
  });

  it("matches captured search/list rows to their captured details across both timestamp formats", async () => {
    let matched = 0;
    for (const [stream, path] of [
      ...Object.entries(manifestSearch),
      ["G", "board48-limit10-6.json"],
    ] as [Stream, string][]) {
      const rows = parseMetadata(
        pagePayload(((await fixture(path)).content.feeds ?? []).slice(0, stream === "G" ? 10 : 30)),
        stream,
      );
      for (const row of rows) {
        if (!hasFixture(detailPath(row.feedId))) continue;
        const payload = await fixture(detailPath(row.feedId));
        const detail = await fetchDetail(stream, row, async () => Response.json(payload));
        expect(detail.feedId, path).toBe(row.feedId);
        expect(detail.bodyText.length).toBeGreaterThan(0);
        matched++;
      }
    }
    expect(matched).toBeGreaterThanOrEqual(10);
    // Reads every captured page and detail body; exceeds the 5 s default under suite load.
  }, 30_000);
});

describe("T03 schedule contract", () => {
  it("maps the §1.1 minute slots to one stream each", () => {
    const expected: Record<number, Stream> = {
      0: "A",
      3: "G",
      6: "B",
      12: "C-open",
      18: "C-reopen",
      24: "D",
      33: "G",
      36: "F",
    };
    for (let minute = 0; minute < 60; minute++) {
      const time = Date.parse(`2026-10-18T05:${String(minute).padStart(2, "0")}:00Z`);
      expect(scheduledStream(time), String(minute)).toBe(expected[minute] ?? null);
    }
    expect(Object.values(expected)).not.toContain("E");
  });

  it("defaults to off for any value other than hold/on", () => {
    expect(v2Mode({})).toBe("off");
    for (const value of ["off", "", "ON", "true", "hold "])
      expect(v2Mode({ FORECAST_V2_MODE: value })).toBe("off");
    expect(v2Mode({ FORECAST_V2_MODE: "hold" })).toBe("hold");
    expect(v2Mode({ FORECAST_V2_MODE: "on" })).toBe("on");
  });

  it.each([
    ["2026-10-18T04:59:59.999+09:00", "2026-10-17"],
    ["2026-10-18T05:00:00.000+09:00", "2026-10-18"],
    ["2026-10-18T23:59:59.000+09:00", "2026-10-18"],
    ["2026-10-19T00:00:00.000+09:00", "2026-10-18"],
    ["2026-01-01T04:59:59.000+09:00", "2025-12-31"],
  ])("budget game day of %s is %s (05:00 KST rollover)", (instant, day) => {
    expect(budgetGameDay(Date.parse(instant))).toBe(day);
  });
});
