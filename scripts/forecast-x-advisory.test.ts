import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupplyForecastCandidate } from "../shared/supplyForecastCandidate";
import {
  classifyXAdvisory,
  extractProfileStatusIds,
  fetchFxStatusPayload,
  fetchVerifiedFxPayload,
  fetchXAdvisoryPayload,
  normalizeNikStatusUrl,
  parseFxStatus,
  probeXAdvisory,
} from "./forecast-x-advisory";

const candidate = {
  generatedAt: "2026-08-14T08:00:00.000Z",
  sourceEvidence: [
    {
      source: "naver-board-56",
      publishedAt: "2026-08-14T08:00:00.000Z",
    },
  ],
  schedule: { soloStart: "2026-08-20T03:00:00.000Z" },
} as SupplyForecastCandidate;

const contemporaryStatusId = snowflakeId("2026-08-14T08:10:00.000Z");
const candidateWithCollaboration = {
  ...candidate,
  schedule: {
    ...candidate.schedule,
    collaborationPeriods: [
      {
        effectiveFrom: "2026-08-21T20:00:00.000Z",
        effectiveUntil: "2026-09-01T19:59:00.000Z",
      },
    ],
  },
} as SupplyForecastCandidate;

describe("X forecast advisory", () => {
  it("matches a contemporaneous official status carrying the Naver start date", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "솔로 레이드 시즌 40은 8월 20일 시작됩니다.",
              url: "https://x.com/NIKKE_kr/status/123",
              publishedAt: "2026-08-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidate,
      ),
    ).toMatchObject({ status: "matching", reason: "matched_schedule" });
  });

  it("reports a conflict when a contemporaneous official post has a different date", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "솔로 레이드 8/21 개최",
              url: "https://x.com/NIKKE_kr/status/124",
              publishedAt: "2026-08-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidate,
      ),
    ).toMatchObject({ status: "conflict", reason: "schedule_conflict" });
  });

  it("matches a collaboration post against the confirmed collaboration start", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "콜라보 이벤트는 8/22 시작됩니다.",
              url: "https://x.com/NIKKE_kr/status/125",
              publishedAt: "2026-08-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidateWithCollaboration,
        "profile-html",
      ),
    ).toMatchObject({ status: "matching", reason: "matched_schedule" });
  });

  it("reports a conflicting collaboration start from a structured X source", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "콜라보 이벤트는 8/23 시작됩니다.",
              url: "https://x.com/NIKKE_kr/status/126",
              publishedAt: "2026-08-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidateWithCollaboration,
        "profile-html",
      ),
    ).toMatchObject({ status: "conflict", reason: "schedule_conflict" });
  });

  it("keeps a verified recent URL for manual review when the date is not parseable", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "솔로 레이드의 자세한 일정은 이미지를 확인해 주세요.",
              url: `https://x.com/NIKKE_kr/status/${contemporaryStatusId}`,
              publishedAt: "2026-08-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidate,
        "x-api",
      ),
    ).toEqual({
      status: "unavailable",
      source: "x-api",
      reason: "schedule_not_verified",
      statusUrl: `https://x.com/NIKKE_kr/status/${contemporaryStatusId}`,
      excerpt: "솔로 레이드의 자세한 일정은 이미지를 확인해 주세요.",
    });
  });

  it("keeps rate limits as an unavailable advisory", () => {
    expect(classifyXAdvisory({ posts: [], reason: "rate_limited" }, candidate)).toEqual({
      status: "unavailable",
      source: null,
      reason: "rate_limited",
      statusUrl: null,
      excerpt: null,
    });
  });
});

describe("event and URL boundaries", () => {
  it("does not turn a different event type into a Solo Raid conflict", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "협동 작전은 8/21 개최됩니다.",
              url: "https://x.com/NIKKE_kr/status/125",
              publishedAt: "2026-08-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidate,
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("does not treat an old Solo Raid announcement as a current conflict", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "솔로 레이드 7/21 개최",
              url: "https://x.com/NIKKE_kr/status/126",
              publishedAt: "2026-07-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidate,
      ),
    ).toMatchObject({ status: "unavailable", statusUrl: null });
  });

  it("normalizes only exact NIKKE status URLs", () => {
    expect(normalizeNikStatusUrl("https://twitter.com/nikke_kr/status/123?utm_source=test")).toBe(
      "https://x.com/NIKKE_kr/status/123",
    );
    expect(normalizeNikStatusUrl("https://x.com/someone/status/123")).toBeNull();
    expect(normalizeNikStatusUrl("https://evil.example/NIKKE_kr/status/123")).toBeNull();
  });
});

function snowflakeId(timestamp: string) {
  return ((BigInt(Date.parse(timestamp)) - 1_288_834_974_657n) << 22n).toString();
}

// Synthetic author identity for injected-fetch tests, never an activation source.
const TEST_AUTHOR_ID = "123456789";
const PROFILE_URL = "https://x.com/NIKKE_kr";
const TIMELINE_URL = "https://api.fxtwitter.com/2/profile/NIKKE_kr/statuses?count=10";
const DETAIL_PREFIX = "https://api.fxtwitter.com/2/status/";
const CREATED_AT = "2026-08-14T08:10:00.000Z";

function fxStatus(id = contemporaryStatusId, text = "솔로 레이드 8/20 개최") {
  const createdAt = new Date(Number((BigInt(id) >> 22n) + 1_288_834_974_657n)).toISOString();
  return {
    type: "status",
    id,
    url: `${PROFILE_URL}/status/${id}`,
    author: { id: TEST_AUTHOR_ID, screen_name: "NIKKE_kr" },
    created_at: createdAt,
    created_timestamp: Math.floor(Date.parse(createdAt) / 1_000),
    text: "translated/display text is not evidence",
    raw_text: { text },
  };
}

function ids(count: number) {
  return Array.from({ length: count }, (_, index) =>
    snowflakeId(new Date(Date.parse(CREATED_AT) + index * 1_000).toISOString()),
  );
}

function profileHtml(values: string[]) {
  return values.map((id) => `TimelineTimelineEntry:tweet-${id}`).join(" ");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FxTwitter activation and validity", () => {
  it("fails closed before any request without authoritative author identity", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(fetchXAdvisoryPayload(fetcher)).resolves.toEqual({
      posts: [],
      reason: "author_identity_unverified",
    });
    await expect(probeXAdvisory(candidate, fetcher)).resolves.toEqual({
      status: "unavailable",
      source: "fxtwitter",
      reason: "author_identity_unverified",
      statusUrl: null,
      excerpt: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes equivalent timestamps and uses only the complete original text", () => {
    const value = {
      ...fxStatus(),
      created_at: "Fri Aug 14 08:10:00 +0000 2026",
      text: "솔로 레이드 8/21 개최",
      translation: { text: "솔로 레이드 8/21 개최" },
      raw_text: { text: `${"일반 공지 ".repeat(150)}솔로 레이드 8/20 개최` },
    };
    const post = parseFxStatus(value, contemporaryStatusId, TEST_AUTHOR_ID);
    expect(post?.publishedAt).toBe(CREATED_AT);
    expect(
      classifyXAdvisory({ posts: post ? [post] : [], reason: null }, candidate, "fxtwitter"),
    ).toMatchObject({ status: "matching", source: "fxtwitter" });
  });

  it.each([
    { type: "thread" },
    { id: "99" },
    { id: "https://evil.example/" },
    { url: "https://x.com/someone/status/123" },
    { author: { id: "987654321", screen_name: "NIKKE_kr" } },
    { author: { id: TEST_AUTHOR_ID, screen_name: "someone_else" } },
    { created_at: undefined },
    { created_at: "invalid" },
    { created_timestamp: "1786695000" },
    { created_timestamp: 1 },
    { raw_text: undefined },
    { raw_text: { text: "" } },
    { raw_text: { text: "   " } },
  ])("rejects inconsistent or missing identity, time, and original text: %j", (replacement) => {
    expect(
      parseFxStatus({ ...fxStatus(), ...replacement }, contemporaryStatusId, TEST_AUTHOR_ID),
    ).toBeNull();
  });

  it("does not treat quoted or translated schedule text as the author's announcement", () => {
    const post = parseFxStatus(
      {
        ...fxStatus(contemporaryStatusId, "일반 안내"),
        quote: fxStatus(),
        translation: { text: "솔로 레이드 8/20 개최" },
      },
      contemporaryStatusId,
      TEST_AUTHOR_ID,
    );
    expect(
      classifyXAdvisory({ posts: post ? [post] : [], reason: null }, candidate, "fxtwitter"),
    ).toMatchObject({ status: "unavailable" });
  });

  it.each([undefined, "200", 204, 404])("requires numeric code 200, got %s", async (code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        code,
        status: fxStatus(),
      }),
    );
    await expect(
      fetchFxStatusPayload(contemporaryStatusId, TEST_AUTHOR_ID, fetcher),
    ).resolves.toEqual({ posts: [], reason: "invalid_response" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON and invalid IDs without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{"));
    await expect(
      fetchFxStatusPayload(contemporaryStatusId, TEST_AUTHOR_ID, fetcher),
    ).resolves.toEqual({ posts: [], reason: "invalid_response" });
    await expect(fetchFxStatusPayload("../bad", TEST_AUTHOR_ID, fetcher)).resolves.toEqual({
      posts: [],
      reason: "invalid_response",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("shared per-candidate request budget", () => {
  it("uses one count=10 page, ten unique details, no cursor or extra profile", async () => {
    const discovered = ids(10);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === TIMELINE_URL)
        return Response.json({
          code: 200,
          results: discovered.map((id) => fxStatus(id)),
          cursor: { bottom: "unused" },
        });
      return Response.json({ code: 200, status: fxStatus(url.slice(DETAIL_PREFIX.length)) });
    });
    const payload = await fetchVerifiedFxPayload(TEST_AUTHOR_ID, fetcher);
    expect(payload.posts).toHaveLength(10);
    expect(payload.reason).toBeNull();
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      TIMELINE_URL,
      ...discovered.map((id) => `${DETAIL_PREFIX}${id}`),
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
  });

  it("caps fallback-only discovery at ten details and twelve total requests", async () => {
    const discovered = ids(15);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === TIMELINE_URL) return Response.json({ code: 200, results: [] });
      if (url === PROFILE_URL) return new Response(profileHtml([...discovered, ...discovered]));
      return Response.json({ code: 200, status: fxStatus(url.slice(DETAIL_PREFIX.length)) });
    });
    const payload = await fetchVerifiedFxPayload(TEST_AUTHOR_ID, fetcher);
    expect(payload.posts).toHaveLength(10);
    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(fetcher.mock.calls.filter(([input]) => String(input) === PROFILE_URL)).toHaveLength(1);
    expect(fetcher.mock.calls.slice(2).map(([input]) => String(input))).toEqual(
      discovered
        .slice(5)
        .reverse()
        .map((id) => `${DETAIL_PREFIX}${id}`),
    );
  });

  it("shares the ten-attempt budget across branches, including failed and duplicate IDs", async () => {
    const discovered = ids(12);
    const failedId = discovered[0];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === TIMELINE_URL)
        return Response.json({
          code: 200,
          results: [fxStatus(discovered[0]), fxStatus(discovered[1]), fxStatus(discovered[0])],
        });
      if (url === PROFILE_URL) return new Response(profileHtml([...discovered, ...discovered]));
      if (url === `${DETAIL_PREFIX}${failedId}`) return new Response("limited", { status: 429 });
      return Response.json({ code: 200, status: fxStatus(url.slice(DETAIL_PREFIX.length)) });
    });
    const payload = await fetchVerifiedFxPayload(TEST_AUTHOR_ID, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(12);
    const detailUrls = fetcher.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.startsWith(DETAIL_PREFIX));
    expect(detailUrls).toHaveLength(10);
    expect(new Set(detailUrls).size).toBe(10);
    expect(detailUrls.filter((url) => url.endsWith(`/${failedId}`))).toHaveLength(1);
    expect(payload).toMatchObject({ reason: "rate_limited" });
    expect(payload.posts).toHaveLength(9);
    expect(classifyXAdvisory(payload, candidate, "fxtwitter")).toMatchObject({
      status: "unavailable",
      reason: "rate_limited",
    });
  });

  it.each([
    { code: "200", results: [] },
    { code: 404, results: [] },
    { code: 200, results: ids(11).map((id) => fxStatus(id)) },
    { code: 200, results: [{ ...fxStatus(), author: { id: "999", screen_name: "NIKKE_kr" } }] },
  ])("rejects invalid timeline envelopes without accepting their IDs: %j", async (timeline) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        String(input) === TIMELINE_URL ? Response.json(timeline) : new Response(""),
      );
    await expect(fetchVerifiedFxPayload(TEST_AUTHOR_ID, fetcher)).resolves.toEqual({
      posts: [],
      reason: "invalid_response",
    });
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([TIMELINE_URL, PROFILE_URL]);
  });

  it("uses profile HTML only for IDs, never its schedule text", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        String(input) === TIMELINE_URL
          ? Response.json({ code: 200, results: [] })
          : new Response("솔로 레이드 8/20 개최 https://x.com/NIKKE_kr/status/123"),
      );
    await expect(fetchVerifiedFxPayload(TEST_AUTHOR_ID, fetcher)).resolves.toEqual({
      posts: [],
      reason: "empty_timeline",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      extractProfileStatusIds(profileHtml([contemporaryStatusId, contemporaryStatusId])),
    ).toEqual([contemporaryStatusId]);
  });
});

describe("whole-response transport guards", () => {
  it.each(["timeline", "profile"] as const)(
    "enforces the one-MiB discovery byte guard on %s",
    async (target) => {
      const cancel = vi.fn();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input);
        if (url === (target === "timeline" ? TIMELINE_URL : PROFILE_URL)) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(600_000));
                controller.enqueue(new Uint8Array(600_000));
              },
              cancel,
            }),
          );
        }
        return url === TIMELINE_URL ? Response.json({ code: 200, results: [] }) : new Response("");
      });
      await expect(fetchVerifiedFxPayload(TEST_AUTHOR_ID, fetcher)).resolves.toEqual({
        posts: [],
        reason: "invalid_response",
      });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
        TIMELINE_URL,
        PROFILE_URL,
      ]);
    },
  );

  it.each([
    ["timeline", "headers"],
    ["timeline", "body"],
    ["profile", "headers"],
    ["profile", "body"],
  ] as const)("bounds %s %s consumption to twelve seconds", async (target, stage) => {
    vi.useFakeTimers();
    const targetUrl = target === "timeline" ? TIMELINE_URL : PROFILE_URL;
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url !== targetUrl) {
        return url === TIMELINE_URL ? Response.json({ code: 200, results: [] }) : new Response("");
      }
      if (stage === "headers") return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ cancel }));
    });
    const pending = fetchVerifiedFxPayload(TEST_AUTHOR_ID, fetcher);
    await vi.advanceTimersByTimeAsync(11_999);
    const signal = fetcher.mock.calls.find(([input]) => String(input) === targetUrl)?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ posts: [], reason: "timeout" });
    expect(signal?.aborted).toBe(true);
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([TIMELINE_URL, PROFILE_URL]);
    if (stage === "body") expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("denies redirects without issuing a request to the destination", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("", {
        status: 302,
        headers: { location: "https://evil.example/" },
      }),
    );
    await expect(
      fetchFxStatusPayload(contemporaryStatusId, TEST_AUTHOR_ID, fetcher),
    ).resolves.toEqual({ posts: [], reason: "navigation_error" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it.each([201, 204, 429, 500])("does not accept HTTP %s as success or retry", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(status === 204 ? null : JSON.stringify({ code: 200, status: fxStatus() }), {
        status,
      }),
    );
    await expect(
      fetchFxStatusPayload(contemporaryStatusId, TEST_AUTHOR_ID, fetcher),
    ).resolves.toEqual({
      posts: [],
      reason: status === 429 ? "rate_limited" : "navigation_error",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized declared body before reading it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": String(128 * 1024 + 1) },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(
      fetchFxStatusPayload(contemporaryStatusId, TEST_AUTHOR_ID, fetcher),
    ).resolves.toEqual({ posts: [], reason: "invalid_response" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("counts streamed bytes, even when the declared length is absent or misleading", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("한".repeat(22_000)));
          controller.enqueue(new TextEncoder().encode("한".repeat(22_000)));
        },
        cancel,
      }),
      { headers: { "content-length": "1" } },
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(
      fetchFxStatusPayload(contemporaryStatusId, TEST_AUTHOR_ID, fetcher),
    ).resolves.toEqual({ posts: [], reason: "invalid_response" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["headers", "body"] as const)(
    "times out stalled %s at the detail deadline",
    async (stage) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (stage === "headers") return new Promise<Response>(() => {});
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"code":200'));
            },
            cancel,
          }),
        );
      });
      const pending = fetchFxStatusPayload(contemporaryStatusId, TEST_AUTHOR_ID, fetcher);
      await vi.advanceTimersByTimeAsync(7_999);
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ posts: [], reason: "timeout" });
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      if (stage === "body") expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
});

describe("conflict and incomplete manual holds", () => {
  it.each([false, true])(
    "gives conflicts precedence over matching and partial failure: %s",
    (partial) => {
      const matching = parseFxStatus(fxStatus(), contemporaryStatusId, TEST_AUTHOR_ID);
      const conflicting = parseFxStatus(
        fxStatus(contemporaryStatusId, "솔로 레이드 8/21 개최"),
        contemporaryStatusId,
        TEST_AUTHOR_ID,
      );
      const posts = [matching, conflicting].filter((post) => post !== null);
      for (const order of [posts, [...posts].reverse()]) {
        expect(
          classifyXAdvisory(
            { posts: order, reason: partial ? "timeout" : null },
            candidate,
            "fxtwitter",
          ),
        ).toMatchObject({
          status: "conflict",
          reason: "schedule_conflict",
          source: "fxtwitter",
        });
      }
    },
  );

  it("does not mutate the Naver candidate or promote a third-party match to candidate evidence", () => {
    const original = structuredClone(candidate);
    const post = parseFxStatus(fxStatus(), contemporaryStatusId, TEST_AUTHOR_ID);
    expect(
      classifyXAdvisory({ posts: post ? [post] : [], reason: null }, candidate, "fxtwitter"),
    ).toMatchObject({ status: "matching", source: "fxtwitter" });
    expect(candidate).toEqual(original);
  });
});
